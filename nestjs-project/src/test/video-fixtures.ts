import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

export type VideoFixtureName =
  | 'mp4-h264-aac-faststart'
  | 'mp4-h264-aac-no-faststart'
  | 'mkv-hevc-aac'
  | 'webm-vp9-opus'
  | 'mp4-video-only'
  | 'truncated';

interface FixtureSpec {
  ffmpegArgs: string[];
  fileName: string;
  truncateFrom?: VideoFixtureName;
}

const VIDEO_INPUT = [
  '-f',
  'lavfi',
  '-i',
  'testsrc2=duration=2:size=320x240:rate=25',
];
const AUDIO_INPUT = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'];

const FIXTURE_SPECS: Record<VideoFixtureName, FixtureSpec> = {
  'mp4-h264-aac-faststart': {
    ffmpegArgs: [
      ...VIDEO_INPUT,
      ...AUDIO_INPUT,
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
    ],
    fileName: 'fixture.mp4',
  },
  'mp4-h264-aac-no-faststart': {
    ffmpegArgs: [
      ...VIDEO_INPUT,
      ...AUDIO_INPUT,
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
    ],
    fileName: 'fixture.mp4',
  },
  'mkv-hevc-aac': {
    ffmpegArgs: [
      ...VIDEO_INPUT,
      ...AUDIO_INPUT,
      '-c:v',
      'libx265',
      '-c:a',
      'aac',
    ],
    fileName: 'fixture.mkv',
  },
  'webm-vp9-opus': {
    ffmpegArgs: [
      ...VIDEO_INPUT,
      ...AUDIO_INPUT,
      '-c:v',
      'libvpx-vp9',
      '-c:a',
      'libopus',
    ],
    fileName: 'fixture.webm',
  },
  'mp4-video-only': {
    ffmpegArgs: [...VIDEO_INPUT, '-c:v', 'libx264', '-an'],
    fileName: 'fixture.mp4',
  },
  truncated: {
    ffmpegArgs: [
      ...VIDEO_INPUT,
      ...AUDIO_INPUT,
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
    ],
    fileName: 'fixture.mp4',
    truncateFrom: 'mp4-h264-aac-no-faststart',
  },
};

const fixtureCache = new Map<VideoFixtureName, Promise<string>>();

function hashArgs(parts: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 16);
}

function fixtureDir(name: VideoFixtureName, spec: FixtureSpec): string {
  const hash = hashArgs([name, ...spec.ffmpegArgs]);
  return path.join(os.tmpdir(), 'streamtube-video-fixtures', hash);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runFfmpeg(args: string[], outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args, outputPath]);
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      }
    });
  });
}

async function generateTruncated(
  spec: FixtureSpec,
  targetPath: string,
): Promise<void> {
  if (!spec.truncateFrom) {
    throw new Error('truncated fixture spec is missing truncateFrom');
  }

  const sourcePath = await getVideoFixture(spec.truncateFrom);
  const { size } = await stat(sourcePath);
  const keepBytes = Math.floor(size / 2);

  await pipeline(
    createReadStream(sourcePath, { end: keepBytes - 1 }),
    createWriteStream(targetPath),
  );
}

export async function getVideoFixture(name: VideoFixtureName): Promise<string> {
  const cached = fixtureCache.get(name);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const spec = FIXTURE_SPECS[name];
    const dir = fixtureDir(name, spec);
    const filePath = path.join(dir, spec.fileName);

    if (await fileExists(filePath)) {
      return filePath;
    }

    await mkdir(dir, { recursive: true });

    if (spec.truncateFrom) {
      await generateTruncated(spec, filePath);
    } else {
      await runFfmpeg(spec.ffmpegArgs, filePath);
    }

    return filePath;
  })();

  fixtureCache.set(name, promise);
  return promise;
}

export const ALL_VIDEO_FIXTURES: VideoFixtureName[] = Object.keys(
  FIXTURE_SPECS,
) as VideoFixtureName[];
