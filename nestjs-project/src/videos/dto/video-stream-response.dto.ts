import { ApiProperty } from '@nestjs/swagger';

export class VideoStreamResponseDto {
  @ApiProperty()
  url: string;

  @ApiProperty()
  expires_at: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;
}
