import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { Repository } from 'typeorm';
import { InvalidMediaError } from '../media/media.exceptions';
import { MediaService, type MediaProbeResult } from '../media/media.service';
import { StorageObjectNotFoundException } from '../storage/storage.exceptions';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_QUEUES } from '../videos/videos.constants';

export interface ProcessVideoJobData {
  videoId: string;
}

const PLAYBACK_CONTENT_TYPE = 'video/mp4';
const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';
const THUMBNAIL_CACHE_CONTROL = 'public, max-age=31536000, immutable';

@Processor(VIDEO_QUEUES.PROCESSING)
export class VideoProcessingConsumer extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaService: MediaService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video) {
      throw new UnrecoverableError(`Video ${job.data.videoId} not found`);
    }
    if (video.status === VideoStatus.READY) {
      return;
    }

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'video-processing-'));
    try {
      const sourcePath = path.join(tmpDir, 'source');
      const playbackPath = path.join(tmpDir, 'playback.mp4');
      const thumbnailPath = path.join(tmpDir, 'thumbnail.jpg');

      try {
        await this.storageService.downloadToFile(
          video.original_key,
          sourcePath,
        );
      } catch (error) {
        if (error instanceof StorageObjectNotFoundException) {
          await this.markFailed(video, 'SOURCE_MISSING');
          throw new UnrecoverableError(
            `Source object not found for video ${video.id}`,
          );
        }
        throw error;
      }
      await job.updateProgress(20);

      let probe: MediaProbeResult;
      try {
        probe = await this.mediaService.probe(sourcePath);
      } catch (error) {
        if (error instanceof InvalidMediaError) {
          await this.markFailed(video, 'INVALID_MEDIA');
          throw new UnrecoverableError(`Invalid media for video ${video.id}`);
        }
        throw error;
      }
      await job.updateProgress(40);

      await this.mediaService.normalize(sourcePath, playbackPath, probe);
      await job.updateProgress(70);

      await this.mediaService.extractThumbnail(
        sourcePath,
        thumbnailPath,
        probe.duration_seconds,
      );
      await job.updateProgress(85);

      const playbackKey = `videos/${video.public_id}/playback.mp4`;
      const thumbnailKey = `thumbnails/${randomBytes(16).toString('hex')}.jpg`;

      await Promise.all([
        this.storageService.uploadFile(playbackPath, playbackKey, {
          contentType: PLAYBACK_CONTENT_TYPE,
        }),
        this.storageService.uploadFile(thumbnailPath, thumbnailKey, {
          contentType: THUMBNAIL_CONTENT_TYPE,
          cacheControl: THUMBNAIL_CACHE_CONTROL,
        }),
      ]);

      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.READY,
          duration_seconds: probe.duration_seconds,
          width: probe.width,
          height: probe.height,
          video_codec: probe.video_codec,
          audio_codec: probe.audio_codec,
          playback_key: playbackKey,
          thumbnail_key: thumbnailKey,
          processed_at: new Date(),
        },
      );
      await job.updateProgress(100);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData> | undefined): Promise<void> {
    if (!job) {
      return;
    }
    if (job.attemptsMade < (job.opts.attempts ?? 1)) {
      return;
    }

    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video || video.status === VideoStatus.FAILED) {
      return;
    }

    await this.markFailed(video, 'PROCESSING_ERROR');
  }

  private async markFailed(video: Video, failureReason: string): Promise<void> {
    await this.videoRepository.update(
      { id: video.id },
      {
        status: VideoStatus.FAILED,
        failure_reason: failureReason,
        processed_at: new Date(),
      },
    );
  }
}
