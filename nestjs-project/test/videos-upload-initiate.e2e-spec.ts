import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { Video } from '../src/videos/entities/video.entity';
import type { InitiateUploadResult } from '../src/videos/videos.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { registerConfirmAndLogin } from './support/auth-test-helpers';

describe('POST /videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  describe('POST /videos', () => {
    it('creates a draft and returns the part plan', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner1@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'Minhas Férias.mov',
          content_type: 'video/quicktime',
          size_bytes: 6291456,
        })
        .expect(201);

      expect((res.body as InitiateUploadResult).public_id).toMatch(
        /^[0-9A-Za-z]{11}$/,
      );
      expect((res.body as InitiateUploadResult).title).toBe('Minhas Férias');
      expect((res.body as InitiateUploadResult).status).toBe('uploading');
      expect((res.body as InitiateUploadResult).part_size_bytes).toBe(5242880);
      expect((res.body as InitiateUploadResult).part_count).toBe(2);

      const persisted = await videoRepository.findOneBy({
        public_id: (res.body as InitiateUploadResult).public_id,
      });
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe('uploading');
      expect(persisted!.upload_id).not.toBeNull();
      expect(persisted!.original_filename).toBe('Minhas Férias.mov');
      expect(persisted!.mime_type).toBe('video/quicktime');
      expect(Number(persisted!.size_bytes)).toBe(6291456);
      expect(persisted!.original_key).toBe(
        `videos/${(res.body as InitiateUploadResult).public_id}/original`,
      );
    });

    it('rejects size above the limit with 413', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner2@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'grande.mp4',
          content_type: 'video/mp4',
          size_bytes: 12582913,
        })
        .expect(413);

      expect(res.body).toEqual({
        statusCode: 413,
        error: 'VIDEO_TOO_LARGE',
        message: 'Video exceeds the maximum upload size',
      });

      const count = await videoRepository.count();
      expect(count).toBe(0);
    });

    it('accepts size exactly at the limit', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner3@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'limite.mp4',
          content_type: 'video/mp4',
          size_bytes: 12582912,
        })
        .expect(201);

      expect((res.body as InitiateUploadResult).part_size_bytes).toBe(5242880);
      expect((res.body as InitiateUploadResult).part_count).toBe(3);
    });

    it('rejects a non-video content_type with 400', async () => {
      const { access_token } = await registerConfirmAndLogin(
        app,
        'owner4@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'foto.png',
          content_type: 'image/png',
          size_bytes: 1024,
        })
        .expect(400);

      expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');

      const count = await videoRepository.count();
      expect(count).toBe(0);
    });

    it('rejects a missing access token with 401', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          filename: 'sem-token.mp4',
          content_type: 'video/mp4',
          size_bytes: 1024,
        })
        .expect(401);

      const count = await videoRepository.count();
      expect(count).toBe(0);
    });
  });
});
