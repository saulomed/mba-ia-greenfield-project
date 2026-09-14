import { setTimeout as sleep } from 'node:timers/promises';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { StorageService } from '../src/storage/storage.service';
import { getVideoFixture } from '../src/test/video-fixtures';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { bootstrapE2eApp } from './support/app-test-helpers';
import { registerConfirmAndLogin } from './support/auth-test-helpers';

describe('Video stream and download endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;

  beforeAll(async () => {
    ({ app, dataSource, throttlerStorage } = await bootstrapE2eApp());
    videoRepository = dataSource.getRepository(Video);
    storageService = app.get(StorageService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function seedVideo(
    accessToken: string,
    overrides: Partial<Video>,
  ): Promise<string> {
    const initiateRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'Minhas Férias.mp4',
        content_type: 'video/mp4',
        size_bytes: 6291456,
      });
    const publicId: string = initiateRes.body.public_id;

    await videoRepository.update({ public_id: publicId }, overrides);

    return publicId;
  }

  async function seedReadyVideo(accessToken: string): Promise<string> {
    const publicId = await seedVideo(accessToken, {
      status: VideoStatus.READY,
      playback_key: `videos/${Date.now()}/playback.mp4`,
      processed_at: new Date(),
    });
    const video = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    const fixturePath = await getVideoFixture('mp4-h264-aac-faststart');
    await Promise.all([
      storageService.uploadFile(fixturePath, video.original_key, {
        contentType: 'video/mp4',
      }),
      storageService.uploadFile(fixturePath, video.playback_key!, {
        contentType: 'video/mp4',
      }),
    ]);
    return publicId;
  }

  describe('GET /videos/:publicId/stream', () => {
    it('returns a presigned playback URL for the owner of a ready video', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'stream-owner@example.com',
      );
      const publicId = await seedReadyVideo(access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect(typeof res.body.url).toBe('string');
      expect(res.body.url.length).toBeGreaterThan(0);
      expect(res.body.content_type).toBe('video/mp4');
      expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(
        Date.now(),
      );
    });

    it('serves Range requests directly from storage', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'stream-range@example.com',
      );
      const publicId = await seedReadyVideo(access_token);

      const streamRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      const rangeRes = await fetch(streamRes.body.url, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(rangeRes.status).toBe(206);
      const body = await rangeRes.arrayBuffer();
      expect(body.byteLength).toBe(1024);
      expect(rangeRes.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
    });
  });

  describe('GET /videos/:publicId/download', () => {
    it('returns a presigned download URL that serves the original as an attachment', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'download-owner@example.com',
      );
      const publicId = await seedReadyVideo(access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect(typeof res.body.url).toBe('string');
      expect(res.body.url.length).toBeGreaterThan(0);
      expect(res.body.filename).toBe('Minhas Férias.mp4');
      expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(
        Date.now(),
      );

      const downloadRes = await fetch(res.body.url);
      expect(downloadRes.status).toBe(200);
      const disposition = downloadRes.headers.get('content-disposition');
      expect(disposition).toMatch(/^attachment/);
      expect(disposition).toContain('filename="Minhas Ferias.mp4"');
      expect(disposition).toContain(
        "filename*=UTF-8''Minhas%20F%C3%A9rias.mp4",
      );
    });
  });

  describe('status and authorization on both routes', () => {
    it('returns 409 VIDEO_NOT_READY for uploading, processing and failed videos', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'not-ready@example.com',
      );

      for (const status of [
        VideoStatus.UPLOADING,
        VideoStatus.PROCESSING,
        VideoStatus.FAILED,
      ]) {
        const publicId = await seedVideo(access_token, { status });

        const streamRes = await request(app.getHttpServer())
          .get(`/videos/${publicId}/stream`)
          .set('Authorization', `Bearer ${access_token}`)
          .expect(409);
        expect(streamRes.body.error).toBe('VIDEO_NOT_READY');

        const downloadRes = await request(app.getHttpServer())
          .get(`/videos/${publicId}/download`)
          .set('Authorization', `Bearer ${access_token}`)
          .expect(409);
        expect(downloadRes.body.error).toBe('VIDEO_NOT_READY');
      }
    });

    it('returns the same 404 for a non-owner and for an unknown public_id on both routes', async () => {
      const { access_token: ownerToken } = await registerConfirmAndLogin(
        app,
        'sd-owner-404@example.com',
      );
      const { access_token: otherToken } = await registerConfirmAndLogin(
        app,
        'sd-other-404@example.com',
      );
      const publicId = await seedReadyVideo(ownerToken);

      const streamNonOwnerRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
      expect(streamNonOwnerRes.body.error).toBe('VIDEO_NOT_FOUND');

      const downloadNonOwnerRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
      expect(downloadNonOwnerRes.body.error).toBe('VIDEO_NOT_FOUND');

      const streamUnknownRes = await request(app.getHttpServer())
        .get('/videos/AAAAAAAAAAA/stream')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      expect(streamUnknownRes.body).toEqual(streamNonOwnerRes.body);

      const downloadUnknownRes = await request(app.getHttpServer())
        .get('/videos/AAAAAAAAAAA/download')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      expect(downloadUnknownRes.body).toEqual(downloadNonOwnerRes.body);
    });

    it('returns 401 for a missing access token on both routes', async () => {
      await request(app.getHttpServer())
        .get('/videos/AAAAAAAAAAA/stream')
        .expect(401);
      await request(app.getHttpServer())
        .get('/videos/AAAAAAAAAAA/download')
        .expect(401);
    });
  });

  describe('expired URL', () => {
    const PREVIOUS_TTL = process.env.VIDEO_PLAYBACK_URL_TTL_SECONDS;
    let shortTtlApp: INestApplication<App>;
    let shortTtlDataSource: DataSource;
    let shortTtlThrottler: ThrottlerStorageService;
    let shortTtlVideoRepository: Repository<Video>;
    let shortTtlStorageService: StorageService;

    beforeAll(async () => {
      process.env.VIDEO_PLAYBACK_URL_TTL_SECONDS = '1';
      ({
        app: shortTtlApp,
        dataSource: shortTtlDataSource,
        throttlerStorage: shortTtlThrottler,
      } = await bootstrapE2eApp());
      shortTtlVideoRepository = shortTtlDataSource.getRepository(Video);
      shortTtlStorageService = shortTtlApp.get(StorageService);
    });

    afterAll(async () => {
      await shortTtlApp.close();
      if (PREVIOUS_TTL === undefined) {
        delete process.env.VIDEO_PLAYBACK_URL_TTL_SECONDS;
      } else {
        process.env.VIDEO_PLAYBACK_URL_TTL_SECONDS = PREVIOUS_TTL;
      }
    });

    beforeEach(async () => {
      await cleanAllTables(shortTtlDataSource);
      shortTtlThrottler.storage.clear();
    });

    it('is refused by storage once expires_at has passed', async () => {
      const { access_token } = await registerConfirmAndLogin(
        shortTtlApp,
        'expired-url@example.com',
      );
      const initiateRes = await request(shortTtlApp.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'video.mp4',
          content_type: 'video/mp4',
          size_bytes: 6291456,
        });
      const publicId: string = initiateRes.body.public_id;
      const playbackKey = `videos/${publicId}/playback.mp4`;
      await shortTtlVideoRepository.update(
        { public_id: publicId },
        {
          status: VideoStatus.READY,
          playback_key: playbackKey,
          processed_at: new Date(),
        },
      );
      const fixturePath = await getVideoFixture('mp4-h264-aac-faststart');
      await shortTtlStorageService.uploadFile(fixturePath, playbackKey, {
        contentType: 'video/mp4',
      });

      const res = await request(shortTtlApp.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      const expiresAt = new Date(res.body.expires_at).getTime();
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 2000);

      const deadline = Date.now() + 5000;
      while (Date.now() <= expiresAt && Date.now() < deadline) {
        await sleep(100);
      }

      const expiredRes = await fetch(res.body.url);
      expect(expiredRes.status).toBe(403);
    }, 15000);
  });
});
