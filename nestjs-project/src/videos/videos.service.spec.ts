import { QueryFailedError } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { deriveTitle, computePartPlan, VideosService } from './videos.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoTooLargeException } from './video.exceptions';

function makeUniqueError(): QueryFailedError {
  const driverError = {
    code: '23505',
    detail: 'Key (public_id)=(abc) already exists.',
  };
  return new QueryFailedError('INSERT', [], driverError as unknown as Error);
}

function makeChannel(): Channel {
  const c = new Channel();
  c.id = 'channel-id';
  c.user_id = 'user-id';
  c.nickname = 'nick';
  c.name = 'nick';
  c.description = null;
  c.created_at = new Date();
  c.updated_at = new Date();
  return c;
}

function makeVideoRepository(overrides: Record<string, jest.Mock> = {}): any {
  return {
    create: jest.fn((data) => data),
    save: jest.fn(),
    ...overrides,
  };
}

describe('deriveTitle', () => {
  it('strips the extension', () => {
    expect(deriveTitle('Minhas Férias.mov')).toBe('Minhas Férias');
  });

  it('truncates to 100 characters', () => {
    const longName = 'a'.repeat(150) + '.mp4';
    expect(deriveTitle(longName)).toBe('a'.repeat(100));
  });

  it('keeps filenames without an extension unchanged', () => {
    expect(deriveTitle('no-extension')).toBe('no-extension');
  });

  it('keeps a leading dot as part of the name (dotfile, not an extension)', () => {
    expect(deriveTitle('.hidden')).toBe('.hidden');
  });
});

describe('computePartPlan', () => {
  it('uses the 5 MiB minimum part size for small uploads', () => {
    expect(computePartPlan(6291456)).toEqual({
      part_size_bytes: 5242880,
      part_count: 2,
    });
  });

  it('keeps part_count at or below 10000 for a 10 GB upload', () => {
    const { part_size_bytes, part_count } = computePartPlan(10737418240);
    expect(part_size_bytes).toBeGreaterThanOrEqual(5242880);
    expect(part_count).toBeLessThanOrEqual(10000);
  });
});

describe('VideosService.initiateUpload', () => {
  const dto = {
    filename: 'Minhas Férias.mov',
    content_type: 'video/quicktime',
    size_bytes: 6291456,
  };

  it('throws VideoTooLargeException without calling storage', async () => {
    const storageService = { createMultipartUpload: jest.fn() } as any;
    const channelsService = { findByUserId: jest.fn() } as any;
    const videoRepository = makeVideoRepository();
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { maxUploadBytes: 5000000 } as any,
    );

    await expect(
      service.initiateUpload('user-id', { ...dto, size_bytes: 5000001 }),
    ).rejects.toThrow(VideoTooLargeException);
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('derives a truncated title and persists the draft', async () => {
    const channel = makeChannel();
    const storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id-1'),
    } as any;
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => data as Video),
    });
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { maxUploadBytes: 10737418240 } as any,
    );

    const result = await service.initiateUpload('user-id', dto);

    expect(result.title).toBe('Minhas Férias');
    expect(result.status).toBe(VideoStatus.UPLOADING);
    expect(result.part_size_bytes).toBe(5242880);
    expect(result.part_count).toBe(2);
    expect(videoRepository.save).toHaveBeenCalledTimes(1);
    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^videos\/.+\/original$/),
      'video/quicktime',
    );
  });

  it('retries public_id generation after a unique constraint violation', async () => {
    const channel = makeChannel();
    const storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    } as any;
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      create: jest.fn((data) => data),
      save: jest
        .fn()
        .mockRejectedValueOnce(makeUniqueError())
        .mockImplementationOnce(async (data) => data as Video),
    });
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { maxUploadBytes: 10737418240 } as any,
    );

    const result = await service.initiateUpload('user-id', dto);

    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    expect(storageService.createMultipartUpload).toHaveBeenCalledTimes(2);
    expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
    expect(result.public_id).toBeDefined();
  });
});
