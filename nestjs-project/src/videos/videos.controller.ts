import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { CreatePartUrlsDto } from './dto/create-part-urls.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import type {
  CompleteUploadResult,
  CreatePartUrlsResult,
  InitiateUploadResult,
  ListUploadedPartsResult,
} from './videos.service';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a resumable video upload',
    description:
      'Creates a draft video in the authenticated user channel and opens a multipart upload in storage, returning the part plan for the client to upload bytes directly to storage.',
  })
  @ApiBody({ type: CreateVideoUploadDto })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        public_id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', example: 'uploading' },
        part_size_bytes: { type: 'integer' },
        part_count: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Video exceeds the maximum upload size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':publicId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Issue presigned URLs for a batch of upload parts',
    description:
      'Returns presigned UploadPart URLs for the requested part numbers, so the client can upload bytes directly to storage and resume after a connection failure.',
  })
  @ApiParam({ name: 'publicId', description: 'Video public_id' })
  @ApiBody({ type: CreatePartUrlsDto })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs issued',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            properties: {
              part_number: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
        expires_at: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CreatePartUrlsDto,
  ): Promise<CreatePartUrlsResult> {
    return this.videosService.createPartUrls(user.sub, publicId, dto);
  }

  @Get(':publicId/upload/parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts already received by storage, so the client can resume an interrupted upload.',
  })
  @ApiParam({ name: 'publicId', description: 'Video public_id' })
  @ApiResponse({
    status: 200,
    description: 'Uploaded parts',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            properties: {
              part_number: { type: 'integer' },
              etag: { type: 'string' },
              size_bytes: { type: 'integer' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<ListUploadedPartsResult> {
    return this.videosService.listUploadedParts(user.sub, publicId);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a resumable video upload',
    description:
      'Completes the multipart upload in storage, validates the real object size against the declared size and the configured limit, and enqueues video processing.',
  })
  @ApiParam({ name: 'publicId', description: 'Video public_id' })
  @ApiBody({ type: CompleteVideoUploadDto })
  @ApiResponse({
    status: 202,
    description: 'Upload completed and processing enqueued',
    schema: {
      properties: {
        public_id: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or storage rejected the uploaded parts',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Video exceeds the maximum upload size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Uploaded size does not match the declared size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteVideoUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, publicId, dto);
  }

  @Get(':publicId')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get video detail for the owner',
    description:
      'Returns the video status, extracted metadata and a stable public thumbnail URL, so the owner can follow processing progress.',
  })
  @ApiParam({ name: 'publicId', description: 'Video public_id' })
  @ApiResponse({
    status: 200,
    description: 'Video detail',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwnedVideo(user.sub, publicId);
  }
}
