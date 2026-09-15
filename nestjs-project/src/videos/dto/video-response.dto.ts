import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty()
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ nullable: true, type: String })
  failure_reason: string | null;

  @ApiProperty()
  original_filename: string;

  @ApiProperty()
  mime_type: string;

  @ApiProperty()
  size_bytes: number;

  @ApiProperty({ nullable: true, type: Number })
  duration_seconds: number | null;

  @ApiProperty({ nullable: true, type: Number })
  width: number | null;

  @ApiProperty({ nullable: true, type: Number })
  height: number | null;

  @ApiProperty({ nullable: true, type: String })
  video_codec: string | null;

  @ApiProperty({ nullable: true, type: String })
  audio_codec: string | null;

  @ApiProperty({ nullable: true, type: String })
  thumbnail_url: string | null;

  @ApiProperty()
  created_at: Date;

  @ApiProperty({ nullable: true, type: Date })
  processed_at: Date | null;
}
