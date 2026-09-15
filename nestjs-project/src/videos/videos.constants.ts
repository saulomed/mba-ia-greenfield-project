export const VIDEO_QUEUES = {
  PROCESSING: 'video-processing',
  MAINTENANCE: 'video-maintenance',
} as const;

export const VIDEO_JOBS = {
  PROCESS: 'process',
  EXPIRE_DRAFTS: 'expire-drafts',
} as const;
