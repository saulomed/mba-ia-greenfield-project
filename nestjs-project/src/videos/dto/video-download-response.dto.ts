import { ApiProperty } from '@nestjs/swagger';

export class VideoDownloadResponseDto {
  @ApiProperty()
  url: string;

  @ApiProperty()
  expires_at: string;

  @ApiProperty()
  filename: string;
}
