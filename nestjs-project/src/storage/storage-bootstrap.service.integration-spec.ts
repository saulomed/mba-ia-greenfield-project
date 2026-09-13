import { randomUUID } from 'node:crypto';
import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { createS3Client } from './create-s3-client';
import { StorageBootstrapService } from './storage-bootstrap.service';

describe('StorageBootstrapService (integration)', () => {
  const testBucket = `streamtube-test-${randomUUID()}`;
  const storageCfg = { ...storageConfig(), bucket: testBucket };
  const videoCfg = videoConfig();
  const client = createS3Client(storageCfg, storageCfg.endpoint);
  const service = new StorageBootstrapService(client, storageCfg, videoCfg);

  beforeAll(async () => {
    await service.onApplicationBootstrap();
    await client.send(
      new PutObjectCommand({
        Bucket: testBucket,
        Key: 'thumbnails/probe.txt',
        Body: 'probe',
      }),
    );
    await client.send(
      new PutObjectCommand({
        Bucket: testBucket,
        Key: 'videos/probe.txt',
        Body: 'probe',
      }),
    );
  });

  afterAll(async () => {
    await client
      .send(
        new DeleteObjectCommand({
          Bucket: testBucket,
          Key: 'thumbnails/probe.txt',
        }),
      )
      .catch(() => undefined);
    await client
      .send(
        new DeleteObjectCommand({
          Bucket: testBucket,
          Key: 'videos/probe.txt',
        }),
      )
      .catch(() => undefined);
    await client
      .send(new DeleteBucketCommand({ Bucket: testBucket }))
      .catch(() => undefined);
  });

  it('creates the bucket when it does not exist', async () => {
    await expect(
      client.send(new HeadBucketCommand({ Bucket: testBucket })),
    ).resolves.toBeDefined();
  });

  it('allows anonymous GET on an object under thumbnails/', async () => {
    const res = await fetch(
      `${storageCfg.endpoint}/${testBucket}/thumbnails/probe.txt`,
    );
    expect(res.status).toBe(200);
  });

  it('denies anonymous GET on an object outside thumbnails/', async () => {
    const res = await fetch(
      `${storageCfg.endpoint}/${testBucket}/videos/probe.txt`,
    );
    expect(res.status).toBe(403);
  });

  it('denies anonymous bucket listing', async () => {
    const res = await fetch(`${storageCfg.endpoint}/${testBucket}`);
    expect(res.status).toBe(403);
  });

  it('does not fail when run a second time against an already-configured bucket', async () => {
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
