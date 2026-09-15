import { S3Client } from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

export function createS3Client(
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client {
  return new S3Client({
    endpoint,
    forcePathStyle: true,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
}
