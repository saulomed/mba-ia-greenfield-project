import { spawn } from 'node:child_process';
import { MediaCommandError } from './media.exceptions';

const MAX_STDERR_CHARS = 8192;

export interface RunFfmpegOptions {
  timeoutMs?: number;
}

export function runFfmpegCommand(
  command: 'ffmpeg' | 'ffprobe',
  args: string[],
  options: RunFfmpegOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
    });

    const stdoutChunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr += chunk.toString();
      }
    });

    proc.on('error', (err) => {
      reject(new MediaCommandError(command, null, err.message));
    });

    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString());
      } else if (signal) {
        reject(
          new MediaCommandError(
            command,
            code,
            `terminated by signal ${signal} (possible timeout)`,
          ),
        );
      } else {
        reject(new MediaCommandError(command, code, stderr));
      }
    });
  });
}
