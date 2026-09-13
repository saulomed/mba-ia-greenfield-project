import { Injectable } from '@nestjs/common';
import { runFfmpegCommand } from './ffmpeg.runner';
import {
  MEDIA_COMMAND_TIMEOUTS_MS,
  THUMBNAIL_MAX_WIDTH,
} from './media.constants';
import { InvalidMediaError, MediaCommandError } from './media.exceptions';

export interface MediaProbeResult {
  duration_seconds: number;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
}

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

function assertMedia(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new InvalidMediaError(message);
  }
}

export function shouldRemux(
  probe: Pick<MediaProbeResult, 'video_codec' | 'audio_codec'>,
): boolean {
  return (
    probe.video_codec === 'h264' &&
    (probe.audio_codec === 'aac' || probe.audio_codec === null)
  );
}

export function buildNormalizeArgs(
  inputPath: string,
  outputPath: string,
  probe: MediaProbeResult,
): string[] {
  const codecArgs = shouldRemux(probe)
    ? ['-c', 'copy']
    : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];

  return [
    '-y',
    '-i',
    inputPath,
    ...codecArgs,
    '-movflags',
    '+faststart',
    outputPath,
  ];
}

export function thumbnailTimestampSeconds(durationSeconds: number): number {
  return Math.min(1, durationSeconds / 2);
}

export function buildThumbnailArgs(
  inputPath: string,
  outputPath: string,
  durationSeconds: number,
): string[] {
  return [
    '-y',
    '-ss',
    thumbnailTimestampSeconds(durationSeconds).toFixed(3),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
    outputPath,
  ];
}

@Injectable()
export class MediaService {
  async probe(path: string): Promise<MediaProbeResult> {
    let stdout: string;
    try {
      stdout = await runFfmpegCommand(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          path,
        ],
        { timeoutMs: MEDIA_COMMAND_TIMEOUTS_MS.PROBE },
      );
    } catch (error) {
      if (error instanceof MediaCommandError) {
        throw new InvalidMediaError(`ffprobe failed for ${path}`, error);
      }
      throw error;
    }

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch (error) {
      throw new InvalidMediaError(
        `ffprobe returned invalid JSON for ${path}`,
        error,
      );
    }

    const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
    assertMedia(
      videoStream && videoStream.width != null && videoStream.height != null,
      `no video stream found in ${path}`,
    );

    const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');

    const durationSeconds = Number(
      parsed.format?.duration ?? videoStream.duration,
    );
    assertMedia(
      Number.isFinite(durationSeconds),
      `unable to determine duration for ${path}`,
    );

    return {
      duration_seconds: durationSeconds,
      width: videoStream.width,
      height: videoStream.height,
      video_codec: videoStream.codec_name,
      audio_codec: audioStream?.codec_name ?? null,
    };
  }

  async normalize(
    inputPath: string,
    outputPath: string,
    probe: MediaProbeResult,
  ): Promise<void> {
    await runFfmpegCommand(
      'ffmpeg',
      buildNormalizeArgs(inputPath, outputPath, probe),
      { timeoutMs: MEDIA_COMMAND_TIMEOUTS_MS.NORMALIZE },
    );
  }

  async extractThumbnail(
    inputPath: string,
    outputPath: string,
    durationSeconds: number,
  ): Promise<void> {
    await runFfmpegCommand(
      'ffmpeg',
      buildThumbnailArgs(inputPath, outputPath, durationSeconds),
      { timeoutMs: MEDIA_COMMAND_TIMEOUTS_MS.THUMBNAIL },
    );
  }
}
