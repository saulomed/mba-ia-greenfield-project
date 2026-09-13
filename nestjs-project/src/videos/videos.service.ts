import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-unique-violation.util';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { VideoTooLargeException } from './video.exceptions';

const PUBLIC_ID_COLUMN = 'public_id';
const MAX_PUBLIC_ID_RETRIES = 5;
const TITLE_MAX_LENGTH = 100;
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PART_COUNT = 10000;
const PART_SIZE_ROUNDING_BYTES = 1024 * 1024;

export function deriveTitle(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  const withoutExtension = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  return withoutExtension.slice(0, TITLE_MAX_LENGTH);
}

export interface PartPlan {
  part_size_bytes: number;
  part_count: number;
}

export function computePartPlan(sizeBytes: number): PartPlan {
  const rawPartSize = Math.max(
    MIN_PART_SIZE_BYTES,
    Math.ceil(sizeBytes / MAX_PART_COUNT),
  );
  const part_size_bytes =
    Math.ceil(rawPartSize / PART_SIZE_ROUNDING_BYTES) *
    PART_SIZE_ROUNDING_BYTES;
  const part_count = Math.ceil(sizeBytes / part_size_bytes);
  return { part_size_bytes, part_count };
}

export interface InitiateUploadResult {
  public_id: string;
  title: string;
  status: VideoStatus;
  part_size_bytes: number;
  part_count: number;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoUploadDto,
  ): Promise<InitiateUploadResult> {
    if (dto.size_bytes > this.config.maxUploadBytes) {
      throw new VideoTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const title = deriveTitle(dto.filename);
    const { part_size_bytes, part_count } = computePartPlan(dto.size_bytes);

    for (let attempt = 0; attempt <= MAX_PUBLIC_ID_RETRIES; attempt++) {
      const publicId = generatePublicId();
      const originalKey = `videos/${publicId}/original`;
      let uploadId: string | undefined;

      try {
        uploadId = await this.storageService.createMultipartUpload(
          originalKey,
          dto.content_type,
        );

        const video = await this.videoRepository.save(
          this.videoRepository.create({
            public_id: publicId,
            channel_id: channel.id,
            title,
            status: VideoStatus.UPLOADING,
            original_filename: dto.filename,
            mime_type: dto.content_type,
            size_bytes: dto.size_bytes,
            original_key: originalKey,
            upload_id: uploadId,
          }),
        );

        return {
          public_id: video.public_id,
          title: video.title,
          status: video.status,
          part_size_bytes,
          part_count,
        };
      } catch (err) {
        if (isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN)) {
          // The insert lost the public_id race after the multipart upload was
          // already opened — abort it so it doesn't linger until the bucket's
          // AbortIncompleteMultipartUpload lifecycle rule cleans it up.
          if (uploadId) {
            await this.storageService.abortMultipartUpload(
              originalKey,
              uploadId,
            );
          }
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      'public_id conflict could not be resolved after max retries',
    );
  }
}
