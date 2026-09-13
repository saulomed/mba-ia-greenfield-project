import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { Video } from './entities/video.entity';
import { VIDEO_QUEUES } from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    QueueModule,
    BullModule.registerQueue(
      { name: VIDEO_QUEUES.PROCESSING },
      { name: VIDEO_QUEUES.MAINTENANCE },
    ),
  ],
  exports: [TypeOrmModule],
})
export class VideosModule {}
