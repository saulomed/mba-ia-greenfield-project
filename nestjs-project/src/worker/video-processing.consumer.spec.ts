import { readdir } from 'node:fs/promises';
import * as os from 'node:os';
import type { Job } from 'bullmq';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoProcessingConsumer } from './video-processing.consumer';

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  Object.assign(video, {
    id: 'video-1',
    public_id: 'abc12345678',
    original_key: 'videos/video-1/original',
    status: VideoStatus.PROCESSING,
    ...overrides,
  });
  return video;
}

function makeJob(overrides: Partial<Job> = {}): Job<{ videoId: string }> {
  return {
    data: { videoId: 'video-1' },
    updateProgress: jest.fn().mockResolvedValue(undefined),
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as unknown as Job<{ videoId: string }>;
}

describe('VideoProcessingConsumer', () => {
  describe('process — temporary directory cleanup', () => {
    it('removes the temporary directory even when normalize fails', async () => {
      const videoRepository = {
        findOneBy: jest.fn().mockResolvedValue(makeVideo()),
        update: jest.fn().mockResolvedValue(undefined),
      } as any;
      const storageService = {
        downloadToFile: jest.fn().mockResolvedValue(undefined),
      } as any;
      const mediaService = {
        probe: jest.fn().mockResolvedValue({
          duration_seconds: 2,
          width: 320,
          height: 240,
          video_codec: 'hevc',
          audio_codec: 'aac',
        }),
        normalize: jest.fn().mockRejectedValue(new Error('ffmpeg boom')),
        extractThumbnail: jest.fn(),
      } as any;
      const consumer = new VideoProcessingConsumer(
        videoRepository,
        storageService,
        mediaService,
      );
      await expect(consumer.process(makeJob())).rejects.toThrow('ffmpeg boom');

      const entries = await readdir(os.tmpdir());
      const leftover = entries.filter((name) =>
        name.startsWith('video-processing-'),
      );
      expect(leftover).toEqual([]);
    });
  });

  describe('onFailed', () => {
    it('does not mark the video when the attempt is not the last one', async () => {
      const videoRepository = {
        findOneBy: jest.fn(),
        update: jest.fn(),
      } as any;
      const consumer = new VideoProcessingConsumer(
        videoRepository,
        {} as any,
        {} as any,
      );

      await consumer.onFailed(makeJob({ attemptsMade: 1 }));

      expect(videoRepository.findOneBy).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('marks status failed with PROCESSING_ERROR on the last attempt', async () => {
      const videoRepository = {
        findOneBy: jest.fn().mockResolvedValue(makeVideo()),
        update: jest.fn().mockResolvedValue(undefined),
      } as any;
      const consumer = new VideoProcessingConsumer(
        videoRepository,
        {} as any,
        {} as any,
      );

      await consumer.onFailed(makeJob({ attemptsMade: 3 }));

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        expect.objectContaining({
          status: VideoStatus.FAILED,
          failure_reason: 'PROCESSING_ERROR',
        }),
      );
    });

    it('does not mark the video again when it is already failed', async () => {
      const videoRepository = {
        findOneBy: jest
          .fn()
          .mockResolvedValue(makeVideo({ status: VideoStatus.FAILED })),
        update: jest.fn(),
      } as any;
      const consumer = new VideoProcessingConsumer(
        videoRepository,
        {} as any,
        {} as any,
      );

      await consumer.onFailed(makeJob({ attemptsMade: 3 }));

      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });
});
