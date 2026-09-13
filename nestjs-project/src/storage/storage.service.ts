import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { STORAGE_CLIENT, STORAGE_PRESIGN_CLIENT } from './storage.constants';
import {
  StorageInvalidPartsException,
  StorageObjectNotFoundException,
} from './storage.exceptions';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

const INVALID_PART_ERROR_NAMES = [
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
];
const OBJECT_NOT_FOUND_ERROR_NAMES = ['NoSuchKey', 'NotFound'];
const UPLOAD_NOT_FOUND_ERROR_NAMES = ['NoSuchUpload'];

function isErrorNamed(error: unknown, names: string[]): boolean {
  return error instanceof Error && names.includes(error.name);
}

function rethrowTranslated(
  error: unknown,
  names: string[],
  build: () => Error,
): never {
  if (isErrorNamed(error, names)) {
    throw build();
  }
  throw error;
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_CLIENT) private readonly client: S3Client,
    @Inject(STORAGE_PRESIGN_CLIENT) private readonly presignClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async createMultipartUpload(
    key: string,
    contentType?: string,
  ): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!result.UploadId) {
      throw new Error(
        'S3 did not return an UploadId for CreateMultipartUpload',
      );
    }

    return result.UploadId;
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let partNumberMarker: string | undefined;
    let isTruncated = true;

    while (isTruncated) {
      const result = await this.client.send(
        new ListPartsCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker,
        }),
      );

      for (const part of result.Parts ?? []) {
        if (
          part.PartNumber === undefined ||
          part.ETag === undefined ||
          part.Size === undefined
        ) {
          continue;
        }
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size,
        });
      }

      isTruncated = result.IsTruncated ?? false;
      partNumberMarker = result.NextPartNumberMarker;
    }

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      rethrowTranslated(
        error,
        INVALID_PART_ERROR_NAMES,
        () => new StorageInvalidPartsException(error),
      );
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (isErrorNamed(error, UPLOAD_NOT_FOUND_ERROR_NAMES)) {
        return;
      }
      throw error;
    }
  }

  async headObject(key: string): Promise<{ contentLength: number }> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );

      if (result.ContentLength === undefined) {
        throw new Error('S3 did not return ContentLength for HeadObject');
      }

      return { contentLength: result.ContentLength };
    } catch (error) {
      rethrowTranslated(
        error,
        OBJECT_NOT_FOUND_ERROR_NAMES,
        () => new StorageObjectNotFoundException(key, error),
      );
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  async downloadToFile(key: string, path: string): Promise<void> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );

      if (!result.Body) {
        throw new Error('S3 did not return a Body for GetObject');
      }

      await pipeline(result.Body as Readable, createWriteStream(path));
    } catch (error) {
      rethrowTranslated(
        error,
        OBJECT_NOT_FOUND_ERROR_NAMES,
        () => new StorageObjectNotFoundException(key, error),
      );
    }
  }

  async uploadFile(
    path: string,
    key: string,
    options: { contentType?: string; cacheControl?: string } = {},
  ): Promise<void> {
    const { size } = await stat(path);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: options.contentType,
        CacheControl: options.cacheControl,
      }),
    );
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async presignGetObject(
    key: string,
    expiresIn: number,
    options: { responseContentDisposition?: string } = {},
  ): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn },
    );
  }
}
