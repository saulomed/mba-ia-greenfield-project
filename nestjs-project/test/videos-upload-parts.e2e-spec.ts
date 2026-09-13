import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { buildSyntheticPart } from '../src/test/synthetic-bytes';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { bootstrapE2eApp } from './support/app-test-helpers';
import { registerConfirmAndLogin } from './support/auth-test-helpers';

describe('Upload parts endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    ({ app, dataSource, throttlerStorage } = await bootstrapE2eApp());
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function createDraft(accessToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'video.mp4',
        content_type: 'video/mp4',
        size_bytes: 6291456,
      });
    return res.body.public_id;
  }

  describe('POST /videos/:publicId/upload/part-urls', () => {
    it('returns presigned URLs for the requested parts', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner1@example.com',
      );
      const publicId = await createDraft(access_token);
      const before = Date.now();

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ part_numbers: [1, 2] })
        .expect(200);

      expect(res.body.parts).toEqual([
        { part_number: 1, url: expect.any(String) },
        { part_number: 2, url: expect.any(String) },
      ]);
      expect(res.body.parts[0].url).not.toBe('');
      expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(before);
    });

    it('accepts a part upload on the presigned URL', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner2@example.com',
      );
      const publicId = await createDraft(access_token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ part_numbers: [1] })
        .expect(200);

      const putResponse = await fetch(res.body.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(buildSyntheticPart(1, 5242880)),
      });

      expect(putResponse.status).toBe(200);
      expect(putResponse.headers.get('etag')).toBeTruthy();
    });

    it('rejects more than 100 part_numbers with 400', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner3@example.com',
      );
      const publicId = await createDraft(access_token);
      const partNumbers = Array.from({ length: 101 }, (_, i) => i + 1);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ part_numbers: partNumbers })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('rejects a part_number above part_count with 400', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner4@example.com',
      );
      const publicId = await createDraft(access_token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ part_numbers: [3] })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /videos/:publicId/upload/parts', () => {
    it('lists uploaded parts after a PUT', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner5@example.com',
      );
      const publicId = await createDraft(access_token);

      const partUrlsRes = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ part_numbers: [1] })
        .expect(200);

      const putResponse = await fetch(partUrlsRes.body.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(buildSyntheticPart(1, 5242880)),
      });
      const etag = putResponse.headers.get('etag');

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect(res.body.parts).toEqual([
        { part_number: 1, etag, size_bytes: 5242880 },
      ]);
    });

    it('lists empty when no part has been uploaded', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner6@example.com',
      );
      const publicId = await createDraft(access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect(res.body.parts).toEqual([]);
    });
  });

  describe('authorization and state (both routes)', () => {
    it('returns 404 VIDEO_NOT_FOUND for a non-owner on both routes', async () => {
      const { access_token: ownerToken } = await registerConfirmAndLogin(
        app,
        'owner7@example.com',
      );
      const { access_token: otherToken } = await registerConfirmAndLogin(
        app,
        'other7@example.com',
      );
      const publicId = await createDraft(ownerToken);

      const postRes = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ part_numbers: [1] })
        .expect(404);
      expect(postRes.body.error).toBe('VIDEO_NOT_FOUND');

      const getRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
      expect(getRes.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns the same 404 for an unknown public_id', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner8@example.com',
      );

      const postRes = await request(app.getHttpServer())
        .post('/videos/AAAAAAAAAAA/upload/part-urls')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ part_numbers: [1] })
        .expect(404);
      expect(postRes.body.error).toBe('VIDEO_NOT_FOUND');

      const getRes = await request(app.getHttpServer())
        .get('/videos/AAAAAAAAAAA/upload/parts')
        .set('Authorization', `Bearer ${access_token}`)
        .expect(404);
      expect(getRes.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 409 VIDEO_UPLOAD_NOT_IN_PROGRESS on both routes for a processing video', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner9@example.com',
      );
      const publicId = await createDraft(access_token);
      await videoRepository.update(
        { public_id: publicId },
        { status: VideoStatus.PROCESSING },
      );

      const postRes = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ part_numbers: [1] })
        .expect(409);
      expect(postRes.body.error).toBe('VIDEO_UPLOAD_NOT_IN_PROGRESS');

      const getRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(409);
      expect(getRes.body.error).toBe('VIDEO_UPLOAD_NOT_IN_PROGRESS');
    });

    it('returns 401 for a missing access token on both routes', async () => {
      await request(app.getHttpServer())
        .post('/videos/AAAAAAAAAAA/upload/part-urls')
        .send({ part_numbers: [1] })
        .expect(401);

      await request(app.getHttpServer())
        .get('/videos/AAAAAAAAAAA/upload/parts')
        .expect(401);
    });
  });
});
