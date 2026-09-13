import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `chan_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  function baseVideoData(channelId: string) {
    return {
      public_id: randomUUID().replace(/-/g, '').slice(0, 11),
      channel_id: channelId,
      title: 'My video',
      original_filename: 'my-video.mp4',
      mime_type: 'video/mp4',
      size_bytes: 1024,
      original_key: 'videos/abc/original',
    };
  }

  it('should default status to uploading when not provided', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create(baseVideoData(channel.id)),
    );

    expect(video.status).toBe(VideoStatus.UPLOADING);
  });

  it('should reject a duplicate public_id', async () => {
    const channel = await createChannel();
    const data = baseVideoData(channel.id);

    await videoRepository.save(videoRepository.create(data));

    await expect(
      videoRepository.save(
        videoRepository.create({
          ...data,
          original_key: 'videos/def/original',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a non-existent channel_id', async () => {
    await expect(
      videoRepository.save(videoRepository.create(baseVideoData(randomUUID()))),
    ).rejects.toThrow();
  });

  it('should persist size_bytes above 2^31 and return it as a number', async () => {
    const channel = await createChannel();
    const largeSize = 10737418240; // 10 GiB, exceeds a 32-bit signed integer

    const saved = await videoRepository.save(
      videoRepository.create({
        ...baseVideoData(channel.id),
        size_bytes: largeSize,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(largeSize);
    expect(typeof found.size_bytes).toBe('number');
  });
});
