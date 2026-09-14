import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { MediaService } from '../media/media.service';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { getVideoFixture } from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  ProcessVideoJobData,
  VideoProcessingConsumer,
} from './video-processing.consumer';
import { WorkerModule } from './worker.module';

describe('VideoProcessingConsumer (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let consumer: VideoProcessingConsumer;
  let storageService: StorageService;
  let mediaService: MediaService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    consumer = moduleRef.get(VideoProcessingConsumer);
    storageService = moduleRef.get(StorageService);
    mediaService = moduleRef.get(MediaService);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createDraftVideo(
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `worker_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        public_id: randomUUID().replace(/-/g, '').slice(0, 11),
        channel_id: channel.id,
        title: 'My video',
        original_filename: 'my-video.mkv',
        mime_type: 'video/x-matroska',
        size_bytes: 1024,
        original_key: `videos/${randomUUID()}/original`,
        status: VideoStatus.PROCESSING,
        ...overrides,
      }),
    );
  }

  function fakeJob(videoId: string): Job<ProcessVideoJobData> {
    return {
      data: { videoId },
      updateProgress: jest.fn().mockResolvedValue(undefined),
    } as unknown as Job<ProcessVideoJobData>;
  }

  it('processes a mkv-hevc-aac upload to ready with normalized playback and a public thumbnail', async () => {
    const fixturePath = await getVideoFixture('mkv-hevc-aac');
    const video = await createDraftVideo();
    await storageService.uploadFile(fixturePath, video.original_key, {
      contentType: 'video/x-matroska',
    });

    await consumer.process(fakeJob(video.id));

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.READY);
    expect(updated.duration_seconds).toBeCloseTo(2, 0);
    expect(updated.width).toBe(320);
    expect(updated.height).toBe(240);
    expect(updated.video_codec).toBe('hevc');
    expect(updated.audio_codec).toBe('aac');
    expect(updated.playback_key).toBe(`videos/${video.public_id}/playback.mp4`);
    expect(updated.thumbnail_key).toMatch(/^thumbnails\/[0-9a-f]{32}\.jpg$/);
    expect(updated.processed_at).not.toBeNull();

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'playback-check-'));
    try {
      const playbackPath = path.join(tmpDir, 'playback.mp4');
      await storageService.downloadToFile(updated.playback_key!, playbackPath);
      const playbackProbe = await mediaService.probe(playbackPath);
      expect(playbackProbe.video_codec).toBe('h264');
      expect(playbackProbe.audio_codec).toBe('aac');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }

    const thumbnailUrl = storageService.getPublicUrl(updated.thumbnail_key!);
    const res = await fetch(thumbnailUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('immutable');
  }, 60000);

  it('marks the video failed with INVALID_MEDIA for a truncated upload, without retrying', async () => {
    const fixturePath = await getVideoFixture('truncated');
    const video = await createDraftVideo();
    await storageService.uploadFile(fixturePath, video.original_key, {
      contentType: 'video/mp4',
    });

    await expect(consumer.process(fakeJob(video.id))).rejects.toThrow(
      /Invalid media/,
    );

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.FAILED);
    expect(updated.failure_reason).toBe('INVALID_MEDIA');
  }, 30000);

  it('marks the video failed with SOURCE_MISSING when the original object is absent', async () => {
    const video = await createDraftVideo({
      original_key: `videos/${randomUUID()}/missing`,
    });

    await expect(consumer.process(fakeJob(video.id))).rejects.toThrow(
      /Source object not found/,
    );

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.FAILED);
    expect(updated.failure_reason).toBe('SOURCE_MISSING');
  });

  it('does not change keys when reprocessing an already-ready video', async () => {
    const fixturePath = await getVideoFixture('mkv-hevc-aac');
    const video = await createDraftVideo();
    await storageService.uploadFile(fixturePath, video.original_key, {
      contentType: 'video/x-matroska',
    });
    await consumer.process(fakeJob(video.id));
    const afterFirst = await videoRepository.findOneByOrFail({ id: video.id });

    await consumer.process(fakeJob(video.id));
    const afterSecond = await videoRepository.findOneByOrFail({
      id: video.id,
    });

    expect(afterSecond.playback_key).toBe(afterFirst.playback_key);
    expect(afterSecond.thumbnail_key).toBe(afterFirst.thumbnail_key);
    expect(afterSecond.processed_at).toEqual(afterFirst.processed_at);
  }, 60000);
});
