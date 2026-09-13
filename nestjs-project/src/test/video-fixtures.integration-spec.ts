import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { ALL_VIDEO_FIXTURES, getVideoFixture } from './video-fixtures';

const execFileAsync = promisify(execFile);

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: { duration?: string };
}

async function probe(filePath: string): Promise<FfprobeOutput> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  return JSON.parse(stdout) as FfprobeOutput;
}

describe('video-fixtures', () => {
  it.each(ALL_VIDEO_FIXTURES)('generates the %s fixture on demand', async (name) => {
    const filePath = await getVideoFixture(name);
    const stats = await stat(filePath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('reports duration and resolution for mp4-h264-aac-faststart', async () => {
    const filePath = await getVideoFixture('mp4-h264-aac-faststart');
    const info = await probe(filePath);

    const videoStream = info.streams.find((s) => s.codec_type === 'video');
    const audioStream = info.streams.find((s) => s.codec_type === 'audio');

    expect(videoStream?.codec_name).toBe('h264');
    expect(videoStream?.width).toBe(320);
    expect(videoStream?.height).toBe(240);
    expect(audioStream?.codec_name).toBe('aac');
    expect(Number(info.format.duration)).toBeGreaterThanOrEqual(1.8);
    expect(Number(info.format.duration)).toBeLessThanOrEqual(2.2);
  });

  it('reports no audio stream for mp4-video-only', async () => {
    const filePath = await getVideoFixture('mp4-video-only');
    const info = await probe(filePath);
    const audioStream = info.streams.find((s) => s.codec_type === 'audio');
    expect(audioStream).toBeUndefined();
  });

  it('fails ffprobe for the truncated fixture', async () => {
    const filePath = await getVideoFixture('truncated');
    await expect(probe(filePath)).rejects.toThrow();
  });

  it('does not regenerate an already-cached fixture', async () => {
    const filePath = await getVideoFixture('mkv-hevc-aac');
    const before = await stat(filePath);
    const filePathAgain = await getVideoFixture('mkv-hevc-aac');
    const after = await stat(filePathAgain);

    expect(filePathAgain).toBe(filePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
