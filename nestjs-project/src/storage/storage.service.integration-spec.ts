import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { buildSyntheticPart } from '../test/synthetic-bytes';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageInvalidPartsException } from './storage.exceptions';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let moduleRef: TestingModule;
  let service: StorageService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        StorageModule,
      ],
    }).compile();

    // StorageBootstrapService.onApplicationBootstrap creates the bucket; it only
    // fires on the full Nest lifecycle (init()), not on compile() alone.
    await moduleRef.init();

    service = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  afterEach(async () => {
    while (createdKeys.length > 0) {
      const key = createdKeys.pop() as string;
      await service.deleteObject(key).catch(() => undefined);
    }
  });

  function trackKey(key: string): string {
    createdKeys.push(key);
    return key;
  }

  // @types/node's generic Buffer/Uint8Array<ArrayBufferLike> is structurally
  // incompatible with lib.dom's BodyInit; cast at the fetch() boundary.
  function toBody(buffer: Buffer): BodyInit {
    return new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    ) as BodyInit;
  }

  async function uploadTempFile(
    key: string,
    content: Buffer,
    contentType: string,
  ): Promise<void> {
    const tmpFile = path.join(
      os.tmpdir(),
      `streamtube-storage-test-${randomUUID()}`,
    );
    await writeFile(tmpFile, content);
    try {
      await service.uploadFile(tmpFile, key, { contentType });
    } finally {
      await unlink(tmpFile).catch(() => undefined);
    }
  }

  it('completes a multipart upload started via presigned URLs and reports the right size', async () => {
    const key = trackKey(`videos/test-${randomUUID()}.mp4`);
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const part1 = buildSyntheticPart(1, 5 * 1024 * 1024);
    const part2 = buildSyntheticPart(2, 1 * 1024 * 1024);

    const url1 = await service.presignUploadPart(key, uploadId, 1, 60);
    const url2 = await service.presignUploadPart(key, uploadId, 2, 60);

    const res1 = await fetch(url1, { method: 'PUT', body: toBody(part1) });
    const res2 = await fetch(url2, { method: 'PUT', body: toBody(part2) });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const etag1 = res1.headers.get('etag') as string;
    const etag2 = res2.headers.get('etag') as string;

    const listed = await service.listParts(key, uploadId);
    expect(listed).toHaveLength(2);
    expect(listed.find((p) => p.partNumber === 1)?.size).toBe(5 * 1024 * 1024);
    expect(listed.find((p) => p.partNumber === 2)?.size).toBe(1 * 1024 * 1024);

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(6 * 1024 * 1024);
  });

  it('rejects completion when a non-final part is smaller than the 5 MiB minimum', async () => {
    const key = trackKey(`videos/test-${randomUUID()}.mp4`);
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const undersizedPart = buildSyntheticPart(1, 1024);
    const finalPart = buildSyntheticPart(2, 1024);

    const url1 = await service.presignUploadPart(key, uploadId, 1, 60);
    const url2 = await service.presignUploadPart(key, uploadId, 2, 60);

    const res1 = await fetch(url1, {
      method: 'PUT',
      body: toBody(undersizedPart),
    });
    const res2 = await fetch(url2, { method: 'PUT', body: toBody(finalPart) });

    const etag1 = res1.headers.get('etag') as string;
    const etag2 = res2.headers.get('etag') as string;

    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
      ]),
    ).rejects.toBeInstanceOf(StorageInvalidPartsException);

    await service.abortMultipartUpload(key, uploadId);
  });

  it('does not fail when aborting the same multipart upload twice', async () => {
    const key = trackKey(`videos/test-${randomUUID()}.mp4`);
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    await service.abortMultipartUpload(key, uploadId);
    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
  });

  it('returns a partial 206 response for a ranged GET on a presigned URL', async () => {
    const key = trackKey(`videos/test-${randomUUID()}.mp4`);
    await uploadTempFile(key, buildSyntheticPart(0, 1024), 'video/mp4');

    const url = await service.presignGetObject(key, 60);
    const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(res.status).toBe(206);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(100);
  });

  it('sets the Content-Disposition header from responseContentDisposition', async () => {
    const key = trackKey(`videos/test-${randomUUID()}.mp4`);
    await uploadTempFile(key, buildSyntheticPart(0, 1024), 'video/mp4');

    const url = await service.presignGetObject(key, 60, {
      responseContentDisposition: 'attachment; filename="video.mp4"',
    });
    const res = await fetch(url);

    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="video.mp4"',
    );
  });
});
