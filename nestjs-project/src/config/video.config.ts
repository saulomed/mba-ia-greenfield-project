import { registerAs } from '@nestjs/config';

export default registerAs('video', () => ({
  maxUploadBytes: parseInt(
    process.env.VIDEO_MAX_UPLOAD_BYTES || '10737418240',
    10,
  ),
  uploadPartUrlTtlSeconds: parseInt(
    process.env.VIDEO_UPLOAD_PART_URL_TTL_SECONDS || '3600',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.VIDEO_PLAYBACK_URL_TTL_SECONDS || '900',
    10,
  ),
  draftTtlHours: parseInt(process.env.VIDEO_DRAFT_TTL_HOURS || '24', 10),
  multipartAbortDays: parseInt(
    process.env.VIDEO_MULTIPART_ABORT_DAYS || '1',
    10,
  ),
}));
