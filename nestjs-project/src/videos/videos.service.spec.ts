import { QueryFailedError } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageInvalidPartsException } from '../storage/storage.exceptions';
import { deriveTitle, computePartPlan, VideosService } from './videos.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  InvalidPartNumbersException,
  InvalidUploadPartsException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
  VideoUploadNotInProgressException,
} from './video.exceptions';

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
    findOne: jest.fn(),
    ...overrides,
  };
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  const v = new Video();
  v.id = 'video-id';
  v.public_id = 'AAAAAAAAAAA';
  v.channel_id = 'channel-id';
  v.title = 'Minhas Férias';
  v.description = null;
  v.status = VideoStatus.UPLOADING;
  v.failure_reason = null;
  v.original_filename = 'Minhas Férias.mov';
  v.mime_type = 'video/quicktime';
  v.size_bytes = 6291456;
  v.original_key = 'videos/AAAAAAAAAAA/original';
  v.upload_id = 'upload-id-1';
  v.playback_key = null;
  v.thumbnail_key = null;
  v.duration_seconds = null;
  v.width = null;
  v.height = null;
  v.video_codec = null;
  v.audio_codec = null;
  v.upload_completed_at = null;
  v.processed_at = null;
  v.created_at = new Date();
  v.updated_at = new Date();
  return Object.assign(v, overrides);
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
      {} as any,
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
      {} as any,
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
      {} as any,
    );

    const result = await service.initiateUpload('user-id', dto);

    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    expect(storageService.createMultipartUpload).toHaveBeenCalledTimes(2);
    expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
    expect(result.public_id).toBeDefined();
  });
});

describe('VideosService.findOwnedByPublicId', () => {
  it('throws VideoNotFoundException when no video matches public_id + channel_id', async () => {
    const channel = makeChannel();
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(null),
    });
    const service = new VideosService(
      videoRepository,
      channelsService,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.findOwnedByPublicId('user-id', 'someone-elses'),
    ).rejects.toThrow(VideoNotFoundException);
    expect(videoRepository.findOne).toHaveBeenCalledWith({
      where: { public_id: 'someone-elses', channel_id: channel.id },
    });
  });
});

describe('VideosService.createPartUrls', () => {
  it('throws VideoUploadNotInProgressException when status is not uploading', async () => {
    const channel = makeChannel();
    const video = makeVideo({ status: VideoStatus.PROCESSING });
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
    });
    const service = new VideosService(
      videoRepository,
      channelsService,
      {} as any,
      { uploadPartUrlTtlSeconds: 3600 } as any,
      {} as any,
    );

    await expect(
      service.createPartUrls('user-id', video.public_id, {
        part_numbers: [1],
      }),
    ).rejects.toThrow(VideoUploadNotInProgressException);
  });

  it('rejects a part_number above part_count', async () => {
    const channel = makeChannel();
    const video = makeVideo({ size_bytes: 6291456 }); // part_count = 2
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
    });
    const service = new VideosService(
      videoRepository,
      channelsService,
      {} as any,
      { uploadPartUrlTtlSeconds: 3600 } as any,
      {} as any,
    );

    await expect(
      service.createPartUrls('user-id', video.public_id, {
        part_numbers: [3],
      }),
    ).rejects.toThrow(InvalidPartNumbersException);
  });

  it('presigns each requested part and sets expires_at respecting the TTL', async () => {
    const channel = makeChannel();
    const video = makeVideo({ size_bytes: 6291456 }); // part_count = 2
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
    });
    const storageService = {
      presignUploadPart: jest
        .fn()
        .mockImplementation(
          async (_key: string, _uploadId: string, partNumber: number) =>
            `https://storage.example/part-${partNumber}`,
        ),
    } as any;
    const ttlSeconds = 3600;
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { uploadPartUrlTtlSeconds: ttlSeconds } as any,
      {} as any,
    );

    const before = Date.now();
    const result = await service.createPartUrls('user-id', video.public_id, {
      part_numbers: [1, 2],
    });
    const after = Date.now();

    expect(result.parts).toEqual([
      { part_number: 1, url: 'https://storage.example/part-1' },
      { part_number: 2, url: 'https://storage.example/part-2' },
    ]);
    expect(storageService.presignUploadPart).toHaveBeenCalledWith(
      video.original_key,
      video.upload_id,
      1,
      ttlSeconds,
    );
    const expiresAtMs = new Date(result.expires_at).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + ttlSeconds * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + ttlSeconds * 1000);
  });
});

describe('VideosService.listUploadedParts', () => {
  it('throws VideoUploadNotInProgressException when status is not uploading', async () => {
    const channel = makeChannel();
    const video = makeVideo({ status: VideoStatus.READY });
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
    });
    const service = new VideosService(
      videoRepository,
      channelsService,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.listUploadedParts('user-id', video.public_id),
    ).rejects.toThrow(VideoUploadNotInProgressException);
  });

  it('maps storage parts to the response shape', async () => {
    const channel = makeChannel();
    const video = makeVideo();
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
    });
    const storageService = {
      listParts: jest
        .fn()
        .mockResolvedValue([{ partNumber: 1, etag: '"abc"', size: 5242880 }]),
    } as any;
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      {} as any,
      {} as any,
    );

    const result = await service.listUploadedParts('user-id', video.public_id);

    expect(result).toEqual({
      parts: [{ part_number: 1, etag: '"abc"', size_bytes: 5242880 }],
    });
    expect(storageService.listParts).toHaveBeenCalledWith(
      video.original_key,
      video.upload_id,
    );
  });
});

describe('VideosService.getOwnedVideo', () => {
  it('returns thumbnail_url null when there is no thumbnail_key', async () => {
    const channel = makeChannel();
    const video = makeVideo({ thumbnail_key: null });
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
    });
    const storageService = { getPublicUrl: jest.fn() } as any;
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      {} as any,
      {} as any,
    );

    const result = await service.getOwnedVideo('user-id', video.public_id);

    expect(result.thumbnail_url).toBeNull();
    expect(storageService.getPublicUrl).not.toHaveBeenCalled();
  });

  it('builds thumbnail_url from the public endpoint and bucket when thumbnail_key is present', async () => {
    const channel = makeChannel();
    const video = makeVideo({
      status: VideoStatus.READY,
      thumbnail_key: 'thumbnails/abc123.jpg',
      duration_seconds: 12.5,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
    });
    const storageService = {
      getPublicUrl: jest
        .fn()
        .mockReturnValue(
          'http://storage.example/test-bucket/thumbnails/abc123.jpg',
        ),
    } as any;
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      {} as any,
      {} as any,
    );

    const result = await service.getOwnedVideo('user-id', video.public_id);

    expect(result.thumbnail_url).toBe(
      'http://storage.example/test-bucket/thumbnails/abc123.jpg',
    );
    expect(storageService.getPublicUrl).toHaveBeenCalledWith(
      'thumbnails/abc123.jpg',
    );
    expect(result.size_bytes).toBe(video.size_bytes);
    expect(typeof result.size_bytes).toBe('number');
    expect(result.duration_seconds).toBe(12.5);
    expect(typeof result.duration_seconds).toBe('number');
  });
});

describe.each([['getStreamUrl' as const], ['getDownloadUrl' as const]])(
  'VideosService.%s',
  (method) => {
    it.each([
      VideoStatus.UPLOADING,
      VideoStatus.PROCESSING,
      VideoStatus.FAILED,
    ])('throws VideoNotReadyException when status is %s', async (status) => {
      const channel = makeChannel();
      const video = makeVideo({ status });
      const channelsService = {
        findByUserId: jest.fn().mockResolvedValue(channel),
      } as any;
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const service = new VideosService(
        videoRepository,
        channelsService,
        {} as any,
        { playbackUrlTtlSeconds: 900 } as any,
        {} as any,
      );

      await expect(service[method]('user-id', video.public_id)).rejects.toThrow(
        VideoNotReadyException,
      );
    });
  },
);

describe('VideosService.getStreamUrl', () => {
  it('presigns the playback_key and sets expires_at respecting the TTL', async () => {
    const channel = makeChannel();
    const video = makeVideo({
      status: VideoStatus.READY,
      playback_key: 'videos/AAAAAAAAAAA/playback.mp4',
    });
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
    });
    const storageService = {
      presignGetObject: jest
        .fn()
        .mockResolvedValue('https://storage.example/signed-playback'),
    } as any;
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { playbackUrlTtlSeconds: 900 } as any,
      {} as any,
    );

    const before = Date.now();
    const result = await service.getStreamUrl('user-id', video.public_id);
    const after = Date.now();

    expect(result.url).toBe('https://storage.example/signed-playback');
    expect(result.content_type).toBe('video/mp4');
    const expiresAt = new Date(result.expires_at).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 900 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 900 * 1000);
    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      video.playback_key,
      900,
      {},
    );
  });
});

describe('VideosService.getDownloadUrl', () => {
  it('presigns the original_key with an attachment Content-Disposition for the original filename', async () => {
    const channel = makeChannel();
    const video = makeVideo({
      status: VideoStatus.READY,
      original_filename: 'Minhas Férias.mp4',
    });
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
    });
    const storageService = {
      presignGetObject: jest
        .fn()
        .mockResolvedValue('https://storage.example/signed-download'),
    } as any;
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { playbackUrlTtlSeconds: 900 } as any,
      {} as any,
    );

    const result = await service.getDownloadUrl('user-id', video.public_id);

    expect(result.url).toBe('https://storage.example/signed-download');
    expect(result.filename).toBe('Minhas Férias.mp4');
    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      video.original_key,
      900,
      {
        responseContentDisposition:
          'attachment; filename="Minhas Ferias.mp4"; filename*=UTF-8\'\'Minhas%20F%C3%A9rias.mp4',
      },
    );
  });
});

describe('VideosService.completeUpload', () => {
  const dto = {
    parts: [
      { part_number: 2, etag: '"etag-2"' },
      { part_number: 1, etag: '"etag-1"' },
    ],
  };

  it('throws VideoUploadNotInProgressException without touching storage when status is not uploading', async () => {
    const channel = makeChannel();
    const video = makeVideo({ status: VideoStatus.PROCESSING });
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
    });
    const storageService = {
      completeMultipartUpload: jest.fn(),
      headObject: jest.fn(),
      deleteObject: jest.fn(),
    } as any;
    const videoProcessingProducer = { enqueueProcessing: jest.fn() } as any;
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { maxUploadBytes: 12582912 } as any,
      videoProcessingProducer,
    );

    await expect(
      service.completeUpload('user-id', video.public_id, dto),
    ).rejects.toThrow(VideoUploadNotInProgressException);
    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    expect(videoProcessingProducer.enqueueProcessing).not.toHaveBeenCalled();
  });

  it('throws InvalidUploadPartsException without changing status when storage rejects the parts', async () => {
    const channel = makeChannel();
    const video = makeVideo();
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
      update: jest.fn(),
    });
    const storageService = {
      completeMultipartUpload: jest
        .fn()
        .mockRejectedValue(new StorageInvalidPartsException()),
      headObject: jest.fn(),
      deleteObject: jest.fn(),
    } as any;
    const videoProcessingProducer = { enqueueProcessing: jest.fn() } as any;
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { maxUploadBytes: 12582912 } as any,
      videoProcessingProducer,
    );

    await expect(
      service.completeUpload('user-id', video.public_id, dto),
    ).rejects.toThrow(InvalidUploadPartsException);
    expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
      video.original_key,
      video.upload_id,
      [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    );
    expect(videoRepository.update).not.toHaveBeenCalled();
    expect(videoProcessingProducer.enqueueProcessing).not.toHaveBeenCalled();
  });

  it('removes the object and the draft, then throws VideoTooLargeException when the real size exceeds the limit', async () => {
    const channel = makeChannel();
    const video = makeVideo({ size_bytes: 20000000 });
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
      delete: jest.fn(),
    });
    const storageService = {
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 20000000 }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    } as any;
    const videoProcessingProducer = { enqueueProcessing: jest.fn() } as any;
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { maxUploadBytes: 12582912 } as any,
      videoProcessingProducer,
    );

    await expect(
      service.completeUpload('user-id', video.public_id, dto),
    ).rejects.toThrow(VideoTooLargeException);
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      video.original_key,
    );
    expect(videoRepository.delete).toHaveBeenCalledWith({ id: video.id });
    expect(videoProcessingProducer.enqueueProcessing).not.toHaveBeenCalled();
  });

  it('removes the object and the draft, then throws UploadSizeMismatchException when the real size differs from size_bytes', async () => {
    const channel = makeChannel();
    const video = makeVideo({ size_bytes: 6291456 });
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
      delete: jest.fn(),
    });
    const storageService = {
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 7340032 }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    } as any;
    const videoProcessingProducer = { enqueueProcessing: jest.fn() } as any;
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { maxUploadBytes: 12582912 } as any,
      videoProcessingProducer,
    );

    await expect(
      service.completeUpload('user-id', video.public_id, dto),
    ).rejects.toThrow(UploadSizeMismatchException);
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      video.original_key,
    );
    expect(videoRepository.delete).toHaveBeenCalledWith({ id: video.id });
    expect(videoProcessingProducer.enqueueProcessing).not.toHaveBeenCalled();
  });

  it('moves the video to processing and enqueues the process job with jobId = videoId on success', async () => {
    const channel = makeChannel();
    const video = makeVideo({ size_bytes: 6291456 });
    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    } as any;
    const videoRepository = makeVideoRepository({
      findOne: jest.fn().mockResolvedValue(video),
      update: jest.fn(),
    });
    const storageService = {
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 6291456 }),
      deleteObject: jest.fn(),
    } as any;
    const videoProcessingProducer = {
      enqueueProcessing: jest.fn().mockResolvedValue(undefined),
    } as any;
    const service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { maxUploadBytes: 12582912 } as any,
      videoProcessingProducer,
    );

    const result = await service.completeUpload(
      'user-id',
      video.public_id,
      dto,
    );

    expect(result).toEqual({
      public_id: video.public_id,
      status: VideoStatus.PROCESSING,
    });
    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: video.id },
      expect.objectContaining({
        status: VideoStatus.PROCESSING,
        upload_id: null,
        upload_completed_at: expect.any(Date),
      }),
    );
    expect(videoProcessingProducer.enqueueProcessing).toHaveBeenCalledWith(
      video.id,
    );
    expect(storageService.deleteObject).not.toHaveBeenCalled();
  });
});
