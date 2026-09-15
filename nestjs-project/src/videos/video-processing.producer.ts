import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { VIDEO_JOBS, VIDEO_QUEUES } from './videos.constants';

const JOB_ATTEMPTS = 3;
const JOB_BACKOFF_DELAY_MS = 5000;

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_QUEUES.PROCESSING)
    private readonly processingQueue: Queue,
  ) {}

  async enqueueProcessing(videoId: string): Promise<void> {
    await this.processingQueue.add(
      VIDEO_JOBS.PROCESS,
      { videoId },
      {
        jobId: videoId,
        attempts: JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: JOB_BACKOFF_DELAY_MS },
        removeOnComplete: true,
      },
    );
  }
}
