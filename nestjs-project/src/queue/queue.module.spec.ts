import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import { VIDEO_QUEUES } from '../videos/videos.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('should compile and resolve the video-processing and video-maintenance queues', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue(
          { name: VIDEO_QUEUES.PROCESSING },
          { name: VIDEO_QUEUES.MAINTENANCE },
        ),
      ],
    }).compile();

    expect(module.get(getQueueToken(VIDEO_QUEUES.PROCESSING))).toBeDefined();
    expect(module.get(getQueueToken(VIDEO_QUEUES.MAINTENANCE))).toBeDefined();

    await module.close();
  }, 15000);
});
