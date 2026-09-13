export abstract class MediaError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = this.constructor.name;
  }
}

export class MediaCommandError extends MediaError {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    stderr: string,
  ) {
    super(`${command} exited with code ${exitCode}: ${stderr}`);
  }
}

export class InvalidMediaError extends MediaError {}
