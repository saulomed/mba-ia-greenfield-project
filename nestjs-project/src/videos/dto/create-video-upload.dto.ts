import {
  IsInt,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateVideoUploadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  @IsString()
  @Matches(/^video\//)
  content_type: string;

  @IsInt()
  @Min(1)
  size_bytes: number;
}
