import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { buildSyntheticPart } from '../../src/test/synthetic-bytes';
import type {
  CreatePartUrlsResult,
  InitiateUploadResult,
} from '../../src/videos/videos.service';

export async function createDraft(
  app: INestApplication<App>,
  accessToken: string,
  sizeBytes = 6291456,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/videos')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      filename: 'clipe.mp4',
      content_type: 'video/mp4',
      size_bytes: sizeBytes,
    });
  return (res.body as InitiateUploadResult).public_id;
}

export async function uploadParts(
  app: INestApplication<App>,
  accessToken: string,
  publicId: string,
  sizes: number[],
): Promise<{ part_number: number; etag: string }[]> {
  const partNumbers = sizes.map((_, index) => index + 1);
  const partUrlsRes = await request(app.getHttpServer())
    .post(`/videos/${publicId}/upload/part-urls`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ part_numbers: partNumbers })
    .expect(200);

  const parts: { part_number: number; etag: string }[] = [];
  for (const part of (partUrlsRes.body as CreatePartUrlsResult).parts) {
    const size = sizes[part.part_number - 1];
    const putResponse = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(buildSyntheticPart(part.part_number, size)),
    });
    if (putResponse.status !== 200) {
      throw new Error(
        `Upload of part ${part.part_number} failed with status ${putResponse.status}`,
      );
    }
    parts.push({
      part_number: part.part_number,
      etag: putResponse.headers.get('etag')!,
    });
  }
  return parts;
}
