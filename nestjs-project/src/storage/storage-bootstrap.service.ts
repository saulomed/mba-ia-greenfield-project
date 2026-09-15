import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { STORAGE_CLIENT } from './storage.constants';

@Injectable()
export class StorageBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageBootstrapService.name);

  constructor(
    @Inject(STORAGE_CLIENT) private readonly client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
    @Inject(videoConfig.KEY)
    private readonly video: ConfigType<typeof videoConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureBucketExists();
    await Promise.all([
      this.applyMultipartLifecyclePolicy(),
      this.applyThumbnailsReadPolicy(),
    ]);
  }

  private async ensureBucketExists(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.storage.bucket }),
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'NotFound') {
        throw error;
      }
      await this.client.send(
        new CreateBucketCommand({ Bucket: this.storage.bucket }),
      );
    }
  }

  private async applyMultipartLifecyclePolicy(): Promise<void> {
    try {
      await this.client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.storage.bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'abort-incomplete-multipart-uploads',
                Status: 'Enabled',
                Filter: {},
                AbortIncompleteMultipartUpload: {
                  DaysAfterInitiation: this.video.multipartAbortDays,
                },
              },
            ],
          },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Storage rejected the multipart-abort lifecycle rule; relying on MINIO_API_STALE_UPLOADS_EXPIRY instead: ${(error as Error).message}`,
      );
    }
  }

  private async applyThumbnailsReadPolicy(): Promise<void> {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${this.storage.bucket}/thumbnails/*`],
        },
      ],
    };

    await this.client.send(
      new PutBucketPolicyCommand({
        Bucket: this.storage.bucket,
        Policy: JSON.stringify(policy),
      }),
    );
  }
}
