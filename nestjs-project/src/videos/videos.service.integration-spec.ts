import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { videosTestingModuleImports } from './test/videos-testing-module';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
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
});
