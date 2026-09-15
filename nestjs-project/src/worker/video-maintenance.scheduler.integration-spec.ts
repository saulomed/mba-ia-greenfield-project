import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { VIDEO_JOBS, VIDEO_QUEUES } from '../videos/videos.constants';
import { VideoMaintenanceScheduler } from './video-maintenance.scheduler';
import { WorkerModule } from './worker.module';

describe('VideoMaintenanceScheduler (integration)', () => {
  let moduleRef: TestingModule;
  let maintenanceQueue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();

    maintenanceQueue = moduleRef.get(getQueueToken(VIDEO_QUEUES.MAINTENANCE));
  }, 30000);

  afterAll(async () => {
    await maintenanceQueue.removeJobScheduler(VIDEO_JOBS.EXPIRE_DRAFTS);
    await moduleRef.close();
  });

  it('bootstrapping twice results in a single expire-drafts job scheduler', async () => {
    const scheduler = moduleRef.get(VideoMaintenanceScheduler);

    // moduleRef.init() already ran onApplicationBootstrap once; run it again
    // to simulate a second application restart.
    await scheduler.onApplicationBootstrap();

    const schedulers = await maintenanceQueue.getJobSchedulers(0, 9, true);
    const expireDraftsSchedulers = schedulers.filter(
      (jobScheduler) => jobScheduler.key === VIDEO_JOBS.EXPIRE_DRAFTS,
    );
    expect(expireDraftsSchedulers).toHaveLength(1);
  });
});
