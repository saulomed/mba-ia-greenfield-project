import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { VIDEO_JOBS, VIDEO_QUEUES } from '../videos/videos.constants';

const EXPIRE_DRAFTS_INTERVAL_MS = 3600000;

@Injectable()
export class VideoMaintenanceScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_QUEUES.MAINTENANCE)
    private readonly maintenanceQueue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.maintenanceQueue.upsertJobScheduler(
      VIDEO_JOBS.EXPIRE_DRAFTS,
      { every: EXPIRE_DRAFTS_INTERVAL_MS },
      { name: VIDEO_JOBS.EXPIRE_DRAFTS },
    );
  }
}
