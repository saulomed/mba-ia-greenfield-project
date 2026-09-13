import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-unique-violation.util';
import { StorageService } from '../storage/storage.service';
import { StorageInvalidPartsException } from '../storage/storage.exceptions';
import type { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import type { CreatePartUrlsDto } from './dto/create-part-urls.dto';
import type { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  InvalidPartNumbersException,
  InvalidUploadPartsException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoTooLargeException,
  VideoUploadNotInProgressException,
} from './video.exceptions';

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

export interface PartUrl {
  part_number: number;
  url: string;
}

export interface CreatePartUrlsResult {
  parts: PartUrl[];
  expires_at: string;
}

export interface UploadedPartInfo {
  part_number: number;
  etag: string;
  size_bytes: number;
}

export interface ListUploadedPartsResult {
  parts: UploadedPartInfo[];
}

export interface CompleteUploadResult {
  public_id: string;
  status: VideoStatus;
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
    private readonly videoProcessingProducer: VideoProcessingProducer,
  ) {}

  private async requireChannel(userId: string): Promise<Channel> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }
    return channel;
  }

  async findOwnedByPublicId(userId: string, publicId: string): Promise<Video> {
    const channel = await this.requireChannel(userId);
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel_id: channel.id },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async requireUploadInProgress(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.status !== VideoStatus.UPLOADING) {
      throw new VideoUploadNotInProgressException();
    }
    return video;
  }

  async createPartUrls(
    userId: string,
    publicId: string,
    dto: CreatePartUrlsDto,
  ): Promise<CreatePartUrlsResult> {
    const video = await this.requireUploadInProgress(userId, publicId);

    const { part_count } = computePartPlan(video.size_bytes);
    if (dto.part_numbers.some((partNumber) => partNumber > part_count)) {
      throw new InvalidPartNumbersException();
    }

    const ttlSeconds = this.config.uploadPartUrlTtlSeconds;
    const parts = await Promise.all(
      dto.part_numbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.original_key,
          video.upload_id!,
          partNumber,
          ttlSeconds,
        ),
      })),
    );

    return {
      parts,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteVideoUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.requireUploadInProgress(userId, publicId);

    const sortedParts = [...dto.parts].sort(
      (a, b) => a.part_number - b.part_number,
    );

    try {
      await this.storageService.completeMultipartUpload(
        video.original_key,
        video.upload_id!,
        sortedParts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (error) {
      if (error instanceof StorageInvalidPartsException) {
        throw new InvalidUploadPartsException();
      }
      throw error;
    }

    const { contentLength } = await this.storageService.headObject(
      video.original_key,
    );

    if (contentLength > this.config.maxUploadBytes) {
      await this.discardUpload(video);
      throw new VideoTooLargeException();
    }

    if (contentLength !== video.size_bytes) {
      await this.discardUpload(video);
      throw new UploadSizeMismatchException();
    }

    await this.videoRepository.update(
      { id: video.id },
      {
        status: VideoStatus.PROCESSING,
        upload_completed_at: new Date(),
        upload_id: null,
      },
    );

    await this.videoProcessingProducer.enqueueProcessing(video.id);

    return { public_id: video.public_id, status: VideoStatus.PROCESSING };
  }

  private async discardUpload(video: Video): Promise<void> {
    await this.storageService.deleteObject(video.original_key);
    await this.videoRepository.delete({ id: video.id });
  }

  async getOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      failure_reason: video.failure_reason,
      original_filename: video.original_filename,
      mime_type: video.mime_type,
      size_bytes: video.size_bytes,
      duration_seconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      video_codec: video.video_codec,
      audio_codec: video.audio_codec,
      thumbnail_url: video.thumbnail_key
        ? this.storageService.getPublicUrl(video.thumbnail_key)
        : null,
      created_at: video.created_at,
      processed_at: video.processed_at,
    };
  }

  async listUploadedParts(
    userId: string,
    publicId: string,
  ): Promise<ListUploadedPartsResult> {
    const video = await this.requireUploadInProgress(userId, publicId);

    const parts = await this.storageService.listParts(
      video.original_key,
      video.upload_id!,
    );

    return {
      parts: parts.map((part) => ({
        part_number: part.partNumber,
        etag: part.etag,
        size_bytes: part.size,
      })),
    };
  }

  async initiateUpload(
    userId: string,
    dto: CreateVideoUploadDto,
  ): Promise<InitiateUploadResult> {
    if (dto.size_bytes > this.config.maxUploadBytes) {
      throw new VideoTooLargeException();
    }

    const channel = await this.requireChannel(userId);

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
