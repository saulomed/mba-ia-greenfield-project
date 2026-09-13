import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VIDEO_QUEUES } from './videos.constants';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    QueueModule,
    StorageModule,
    ChannelsModule,
    BullModule.registerQueue(
      { name: VIDEO_QUEUES.PROCESSING },
      { name: VIDEO_QUEUES.MAINTENANCE },
    ),
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoProcessingProducer],
  exports: [TypeOrmModule],
})
export class VideosModule {}
