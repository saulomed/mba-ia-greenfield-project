import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_QUEUES } from '../src/videos/videos.constants';
import type { ProcessVideoJobData } from '../src/worker/video-processing.consumer';
import { bootstrapE2eApp } from './support/app-test-helpers';
import { registerConfirmAndLogin } from './support/auth-test-helpers';
import { createDraft, uploadParts } from './support/video-upload-test-helpers';

describe('Video upload complete endpoint (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let videoRepository: Repository<Video>;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    ({ app, dataSource, throttlerStorage } = await bootstrapE2eApp());
    videoRepository = dataSource.getRepository(Video);
    queue = app.get(getQueueToken(VIDEO_QUEUES.PROCESSING));
    await queue.pause();
  });

  afterAll(async () => {
    await queue.resume();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  afterEach(async () => {
    const jobs = await queue.getJobs(['waiting', 'paused', 'delayed']);
    await Promise.all(jobs.map((job) => job.remove()));
  });

  describe('POST /videos/:publicId/upload/complete', () => {
    it('completes the upload and enqueues processing', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'complete-owner1@example.com',
      );
      const publicId = await createDraft(app, access_token);
      const parts = await uploadParts(
        app,
        access_token,
        publicId,
        [5242880, 1048576],
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts })
        .expect(202);

      expect(res.body).toEqual({ public_id: publicId, status: 'processing' });

      const video = await videoRepository.findOneBy({ public_id: publicId });
      expect(video!.status).toBe(VideoStatus.PROCESSING);
      expect(video!.upload_completed_at).not.toBeNull();
      expect(video!.upload_id).toBeNull();

      const job = await queue.getJob(video!.id);
      expect(job).toBeDefined();
      expect(job!.name).toBe('process');
      expect(job!.data).toEqual({ videoId: video!.id });
    });

    it('returns 409 without creating a second job on a repeated complete', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'complete-owner2@example.com',
      );
      const publicId = await createDraft(app, access_token);
      const parts = await uploadParts(
        app,
        access_token,
        publicId,
        [5242880, 1048576],
      );
      await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts })
        .expect(202);
      const video = await videoRepository.findOneBy({ public_id: publicId });

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts })
        .expect(409);

      expect((res.body as ApiErrorEnvelope).error).toBe(
        'VIDEO_UPLOAD_NOT_IN_PROGRESS',
      );

      const jobs = await queue.getJobs(['waiting', 'paused', 'delayed']);
      const matchingJobs = jobs.filter((job) => job.data.videoId === video!.id);
      expect(matchingJobs).toHaveLength(1);
    });

    it('returns 400 and keeps the draft when an etag is wrong', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'complete-owner3@example.com',
      );
      const publicId = await createDraft(app, access_token);
      const parts = await uploadParts(
        app,
        access_token,
        publicId,
        [5242880, 1048576],
      );
      const brokenParts = parts.map((part, index) =>
        index === 1
          ? { ...part, etag: '"00000000000000000000000000000000"' }
          : part,
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: brokenParts })
        .expect(400);
      expect((res.body as ApiErrorEnvelope).error).toBe('INVALID_UPLOAD_PARTS');

      const video = await videoRepository.findOneBy({ public_id: publicId });
      expect(video!.status).toBe(VideoStatus.UPLOADING);
      expect(video!.upload_id).not.toBeNull();

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts })
        .expect(202);
    });

    it('returns 422 and removes the object and the draft on a size mismatch', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'complete-owner4@example.com',
      );
      const publicId = await createDraft(app, access_token);
      const parts = await uploadParts(
        app,
        access_token,
        publicId,
        [5242880, 2097152],
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts })
        .expect(422);
      expect((res.body as ApiErrorEnvelope).error).toBe('UPLOAD_SIZE_MISMATCH');

      const video = await videoRepository.findOneBy({ public_id: publicId });
      expect(video).toBeNull();
    });

    it('returns the same 404 for a non-owner', async () => {
      const { access_token: ownerToken } = await registerConfirmAndLogin(
        app,
        'complete-owner5@example.com',
      );
      const { access_token: otherToken } = await registerConfirmAndLogin(
        app,
        'complete-other5@example.com',
      );
      const publicId = await createDraft(app, ownerToken);
      const parts = await uploadParts(
        app,
        ownerToken,
        publicId,
        [5242880, 1048576],
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts })
        .expect(404);
      expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');

      const video = await videoRepository.findOneBy({ public_id: publicId });
      expect(video!.status).toBe(VideoStatus.UPLOADING);
    });

    it('returns 400 VALIDATION_ERROR for empty parts', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'complete-owner6@example.com',
      );
      const publicId = await createDraft(app, access_token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [] })
        .expect(400);

      expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
    });

    it('returns 401 for a missing access token', async () => {
      await request(app.getHttpServer())
        .post('/videos/AAAAAAAAAAA/upload/complete')
        .send({ parts: [{ part_number: 1, etag: '"abc"' }] })
        .expect(401);
    });
  });
});
