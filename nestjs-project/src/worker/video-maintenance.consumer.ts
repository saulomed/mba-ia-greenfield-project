import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { LessThan, Repository } from 'typeorm';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_QUEUES } from '../videos/videos.constants';

const BATCH_SIZE = 100;
const HOUR_MS = 3600 * 1000;

@Processor(VIDEO_QUEUES.MAINTENANCE)
export class VideoMaintenanceConsumer extends WorkerHost {
  private readonly logger = new Logger(VideoMaintenanceConsumer.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {
    super();
  }

  async process(): Promise<void> {
    const cutoff = new Date(Date.now() - this.config.draftTtlHours * HOUR_MS);

    let batch: Video[];
    do {
      batch = await this.findExpiredBatch(cutoff);
      await Promise.all(batch.map((video) => this.expireDraft(video)));
    } while (batch.length === BATCH_SIZE);
  }

  private findExpiredBatch(cutoff: Date): Promise<Video[]> {
    return this.videoRepository.find({
      where: { status: VideoStatus.UPLOADING, created_at: LessThan(cutoff) },
      take: BATCH_SIZE,
    });
  }

  private async expireDraft(video: Video): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(
        video.original_key,
        video.upload_id!,
      );
      await this.videoRepository.delete({ id: video.id });
    } catch (error) {
      this.logger.error(
        `Failed to expire draft video ${video.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
