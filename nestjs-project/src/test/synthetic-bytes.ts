import { Readable } from 'node:stream';

const BLOCK_SIZE = 64 * 1024;

function fillDeterministic(buffer: Buffer, startOffset: number): void {
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = (startOffset + i) % 256;
  }
}

export function createSyntheticStream(totalBytes: number): Readable {
  let emitted = 0;

  return new Readable({
    read(): void {
      if (emitted >= totalBytes) {
        this.push(null);
        return;
      }

      const chunkSize = Math.min(BLOCK_SIZE, totalBytes - emitted);
      const chunk = Buffer.alloc(chunkSize);
      fillDeterministic(chunk, emitted);
      emitted += chunkSize;
      this.push(chunk);
    },
  });
}

export function buildSyntheticPart(partNumber: number, sizeBytes: number): Buffer {
  const buffer = Buffer.alloc(sizeBytes);
  fillDeterministic(buffer, partNumber * sizeBytes);
  return buffer;
}
