import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { StorageObjectNotFoundException } from '../storage/storage.exceptions';
import { cleanAllTables } from '../test/create-test-data-source';
import { buildSyntheticPart } from '../test/synthetic-bytes';
import { User } from '../users/entities/user.entity';
import { videosTestingModuleImports } from './test/videos-testing-module';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';
import { VideoTooLargeException } from './video.exceptions';
import { VIDEO_QUEUES } from './videos.constants';

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let processingQueue: Queue;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [...videosTestingModuleImports(), VideosModule],
    }).compile();

    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    videosService = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
    processingQueue = moduleRef.get(getQueueToken(VIDEO_QUEUES.PROCESSING));
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channelsService = new ChannelsService(dataSource);
    const channel = await channelsService.createChannel(user.id, user.email);
    return { user, channel };
  }

  async function uploadParts(
    userId: string,
    publicId: string,
    sizes: number[],
  ): Promise<{ part_number: number; etag: string }[]> {
    const partNumbers = sizes.map((_, index) => index + 1);
    const { parts } = await videosService.createPartUrls(userId, publicId, {
      part_numbers: partNumbers,
    });

    const uploaded: { part_number: number; etag: string }[] = [];
    for (const part of parts) {
      const size = sizes[part.part_number - 1];
      const putResponse = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(buildSyntheticPart(part.part_number, size)),
      });
      uploaded.push({
        part_number: part.part_number,
        etag: putResponse.headers.get('etag')!,
      });
    }
    return uploaded;
  }

  it('persists a draft with an upload_id that MinIO accepts for listParts', async () => {
    const { user, channel } = await createUserWithChannel();

    const result = await videosService.initiateUpload(user.id, {
      filename: 'Minhas Férias.mov',
      content_type: 'video/quicktime',
      size_bytes: 6291456,
    });

    expect(result.status).toBe(VideoStatus.UPLOADING);

    const persisted = await videoRepository.findOneBy({
      public_id: result.public_id,
    });
    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe(VideoStatus.UPLOADING);
    expect(persisted!.channel_id).toBe(channel.id);
    expect(persisted!.upload_id).not.toBeNull();
    expect(persisted!.original_key).toBe(`videos/${result.public_id}/original`);

    const parts = await storageService.listParts(
      persisted!.original_key,
      persisted!.upload_id!,
    );
    expect(parts).toEqual([]);
  });

  it('issues a presigned URL that MinIO accepts, then lists the part back', async () => {
    const { user } = await createUserWithChannel();
    const { public_id } = await videosService.initiateUpload(user.id, {
      filename: 'video.mp4',
      content_type: 'video/mp4',
      size_bytes: 6291456,
    });

    const { parts, expires_at } = await videosService.createPartUrls(
      user.id,
      public_id,
      { part_numbers: [1] },
    );

    expect(parts).toEqual([{ part_number: 1, url: expect.any(String) }]);
    expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());

    const partBytes = buildSyntheticPart(1, 5 * 1024 * 1024);
    const putResponse = await fetch(parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(partBytes),
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag');
    expect(etag).toBeTruthy();

    const { parts: uploaded } = await videosService.listUploadedParts(
      user.id,
      public_id,
    );
    expect(uploaded).toEqual([
      { part_number: 1, etag, size_bytes: 5 * 1024 * 1024 },
    ]);
  });

  it('completes a real multipart upload and enqueues a process job with jobId = id', async () => {
    const { user } = await createUserWithChannel();
    const { public_id } = await videosService.initiateUpload(user.id, {
      filename: 'video.mp4',
      content_type: 'video/mp4',
      size_bytes: 6291456,
    });
    const parts = await uploadParts(user.id, public_id, [5242880, 1048576]);

    const result = await videosService.completeUpload(user.id, public_id, {
      parts,
    });

    expect(result.status).toBe(VideoStatus.PROCESSING);

    const video = await videoRepository.findOneBy({ public_id });
    expect(video!.status).toBe(VideoStatus.PROCESSING);
    expect(video!.upload_id).toBeNull();

    const job = await processingQueue.getJob(video!.id);
    expect(job).toBeDefined();
    expect(job!.name).toBe('process');
    expect(job!.data).toEqual({ videoId: video!.id });
  });

  it('rejects a real object whose size exceeds VIDEO_MAX_UPLOAD_BYTES and removes it from the bucket', async () => {
    const { user } = await createUserWithChannel();
    const { public_id } = await videosService.initiateUpload(user.id, {
      filename: 'video.mp4',
      content_type: 'video/mp4',
      size_bytes: 12582912,
    });
    const parts = await uploadParts(
      user.id,
      public_id,
      [5242880, 5242880, 5242880],
    );
    const video = await videoRepository.findOneBy({ public_id });
    const originalKey = video!.original_key;

    await expect(
      videosService.completeUpload(user.id, public_id, { parts }),
    ).rejects.toThrow(VideoTooLargeException);

    await expect(storageService.headObject(originalKey)).rejects.toThrow(
      StorageObjectNotFoundException,
    );
  });
});
