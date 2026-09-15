import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { MediaService } from '../src/media/media.service';
import { StorageService } from '../src/storage/storage.service';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { getVideoFixture } from '../src/test/video-fixtures';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import type { InitiateUploadResult } from '../src/videos/videos.service';
import { bootstrapE2eApp } from './support/app-test-helpers';
import { registerConfirmAndLogin } from './support/auth-test-helpers';

describe('Video detail endpoint (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let mediaService: MediaService;
  let tmpDir: string;

  beforeAll(async () => {
    ({ app, dataSource, throttlerStorage } = await bootstrapE2eApp());
    videoRepository = dataSource.getRepository(Video);
    storageService = app.get(StorageService);
    mediaService = new MediaService();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'videos-detail-e2e-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
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
        filename: 'clipe.mp4',
        content_type: 'video/mp4',
        size_bytes: 6291456,
      });
    const publicId = (initiateRes.body as InitiateUploadResult).public_id;

    await videoRepository.update({ public_id: publicId }, overrides);

    return publicId;
  }

  async function seedThumbnail(): Promise<string> {
    const fixturePath = await getVideoFixture('mp4-h264-aac-faststart');
    const thumbnailPath = path.join(
      tmpDir,
      `${randomBytes(4).toString('hex')}.jpg`,
    );
    await mediaService.extractThumbnail(fixturePath, thumbnailPath, 2);

    const thumbnailKey = `thumbnails/${randomBytes(8).toString('hex')}.jpg`;
    await storageService.uploadFile(thumbnailPath, thumbnailKey, {
      contentType: 'image/jpeg',
    });

    return thumbnailKey;
  }

  describe('GET /videos/:publicId', () => {
    it('returns a draft with null metadata for the owner', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner-draft@example.com',
      );
      const publicId = await seedVideo(access_token, {});

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect(res.body).toMatchObject({
        public_id: publicId,
        status: 'uploading',
        thumbnail_url: null,
        failure_reason: null,
        processed_at: null,
        duration_seconds: null,
        width: null,
        height: null,
        video_codec: null,
        audio_codec: null,
        original_filename: 'clipe.mp4',
        mime_type: 'video/mp4',
        size_bytes: 6291456,
      });
      expect(typeof (res.body as VideoResponseDto).created_at).toBe('string');
      expect(
        new Date((res.body as VideoResponseDto).created_at).toString(),
      ).not.toBe('Invalid Date');
      expect(res.body).not.toHaveProperty('id');
      expect(res.body).not.toHaveProperty('channel_id');
      expect(res.body).not.toHaveProperty('upload_id');
      expect(res.body).not.toHaveProperty('original_key');
      expect(res.body).not.toHaveProperty('playback_key');
    });

    it('returns a ready video with metadata and a publicly accessible thumbnail', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner-ready@example.com',
      );
      const thumbnailKey = await seedThumbnail();
      const publicId = await seedVideo(access_token, {
        status: VideoStatus.READY,
        duration_seconds: 2.0,
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
        playback_key: 'videos/some-id/playback',
        thumbnail_key: thumbnailKey,
        processed_at: new Date(),
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect(res.body).toMatchObject({
        status: 'ready',
        duration_seconds: 2,
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
      });
      expect(typeof (res.body as VideoResponseDto).processed_at).toBe('string');
      expect(
        new Date((res.body as VideoResponseDto).processed_at!).toString(),
      ).not.toBe('Invalid Date');
      expect(res.body).not.toHaveProperty('id');
      expect(res.body).not.toHaveProperty('channel_id');
      expect(res.body).not.toHaveProperty('upload_id');
      expect(res.body).not.toHaveProperty('original_key');
      expect(res.body).not.toHaveProperty('playback_key');

      const thumbnailRes = await fetch(
        (res.body as VideoResponseDto).thumbnail_url!,
      );
      expect(thumbnailRes.status).toBe(200);
      expect(thumbnailRes.headers.get('content-type')).toBe('image/jpeg');
    });

    it('returns failure_reason for a failed video', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner-failed@example.com',
      );
      const publicId = await seedVideo(access_token, {
        status: VideoStatus.FAILED,
        failure_reason: 'INVALID_MEDIA',
        processed_at: new Date(),
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect((res.body as VideoResponseDto).status).toBe('failed');
      expect((res.body as VideoResponseDto).failure_reason).toBe(
        'INVALID_MEDIA',
      );
      expect((res.body as VideoResponseDto).thumbnail_url).toBeNull();
    });

    it('returns the same 404 for a non-owner and for an unknown public_id', async () => {
      const { access_token: ownerToken } = await registerConfirmAndLogin(
        app,
        'owner-404@example.com',
      );
      const { access_token: otherToken } = await registerConfirmAndLogin(
        app,
        'other-404@example.com',
      );
      const publicId = await seedVideo(ownerToken, {});

      const nonOwnerRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
      expect((nonOwnerRes.body as ApiErrorEnvelope).error).toBe(
        'VIDEO_NOT_FOUND',
      );
      expect((nonOwnerRes.body as ApiErrorEnvelope).message).toBe(
        'Video not found',
      );

      const unknownRes = await request(app.getHttpServer())
        .get('/videos/AAAAAAAAAAA')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      expect(unknownRes.body).toEqual(nonOwnerRes.body);
    });

    it('returns 401 for a missing access token', async () => {
      await request(app.getHttpServer()).get('/videos/AAAAAAAAAAA').expect(401);
    });
  });
});
