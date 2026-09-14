import { Test, type TestingModule } from '@nestjs/testing';
import type { ConfigType } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { VideoMaintenanceConsumer } from './video-maintenance.consumer';
import { WorkerModule } from './worker.module';

describe('VideoMaintenanceConsumer (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let consumer: VideoMaintenanceConsumer;
  let storageService: StorageService;
  let config: ConfigType<typeof videoConfig>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    consumer = moduleRef.get(VideoMaintenanceConsumer);
    storageService = moduleRef.get(StorageService);
    config = moduleRef.get(videoConfig.KEY);
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
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `maintenance_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `chan_maint_${counter}`,
        user_id: user.id,
      }),
    );
  }

  async function backdate(id: string, ageHours: number): Promise<void> {
    await videoRepository.update(
      { id },
      { created_at: new Date(Date.now() - ageHours * 3600 * 1000) },
    );
  }

  async function createDraft(ageHours: number): Promise<Video> {
    const channel = await createChannel();
    const publicId = generatePublicId();
    const originalKey = `videos/${publicId}/original`;
    const uploadId = await storageService.createMultipartUpload(
      originalKey,
      'video/mp4',
    );
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'Draft',
        original_filename: 'draft.mp4',
        mime_type: 'video/mp4',
        size_bytes: 1024,
        original_key: originalKey,
        upload_id: uploadId,
        status: VideoStatus.UPLOADING,
      }),
    );
    await backdate(video.id, ageHours);
    return video;
  }

  async function createOldVideo(
    status: VideoStatus,
    ageHours: number,
  ): Promise<Video> {
    const channel = await createChannel();
    const publicId = generatePublicId();
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'Old video',
        original_filename: 'old.mp4',
        mime_type: 'video/mp4',
        size_bytes: 1024,
        original_key: `videos/${publicId}/original`,
        status,
      }),
    );
    await backdate(video.id, ageHours);
    return video;
  }

  it('removes an expired draft and aborts its real multipart upload in MinIO', async () => {
    const draft = await createDraft(config.draftTtlHours + 1);

    await consumer.process();

    expect(await videoRepository.findOneBy({ id: draft.id })).toBeNull();
    await expect(
      storageService.listParts(draft.original_key, draft.upload_id!),
    ).rejects.toThrow();
  });

  it('leaves a recent draft and old processing/ready videos untouched', async () => {
    const recentDraft = await createDraft(config.draftTtlHours - 1);
    const oldProcessing = await createOldVideo(
      VideoStatus.PROCESSING,
      config.draftTtlHours + 10,
    );
    const oldReady = await createOldVideo(
      VideoStatus.READY,
      config.draftTtlHours + 10,
    );

    await consumer.process();

    expect(
      await videoRepository.findOneBy({ id: recentDraft.id }),
    ).not.toBeNull();
    expect(
      (await videoRepository.findOneByOrFail({ id: oldProcessing.id })).status,
    ).toBe(VideoStatus.PROCESSING);
    expect(
      (await videoRepository.findOneByOrFail({ id: oldReady.id })).status,
    ).toBe(VideoStatus.READY);
  });

  it('does not fail on a second run once nothing is left to expire', async () => {
    const draft = await createDraft(config.draftTtlHours + 1);

    await consumer.process();
    expect(await videoRepository.findOneBy({ id: draft.id })).toBeNull();

    await expect(consumer.process()).resolves.toBeUndefined();
  });

  it('removes a draft whose multipart upload was already aborted by storage, without error', async () => {
    const draft = await createDraft(config.draftTtlHours + 1);
    await storageService.abortMultipartUpload(
      draft.original_key,
      draft.upload_id!,
    );

    await expect(consumer.process()).resolves.toBeUndefined();

    expect(await videoRepository.findOneBy({ id: draft.id })).toBeNull();
  });
});
