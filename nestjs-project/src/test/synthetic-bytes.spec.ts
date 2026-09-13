import { buildSyntheticPart, createSyntheticStream } from './synthetic-bytes';

describe('synthetic-bytes', () => {
  describe('createSyntheticStream', () => {
    it('emits exactly totalBytes', async () => {
      const totalBytes = 150_000;
      let received = 0;

      for await (const chunk of createSyntheticStream(totalBytes)) {
        received += (chunk as Buffer).length;
      }

      expect(received).toBe(totalBytes);
    });

    it('produces deterministic content across executions', async () => {
      const totalBytes = 20_000;

      const collect = async (): Promise<Buffer> => {
        const chunks: Buffer[] = [];
        for await (const chunk of createSyntheticStream(totalBytes)) {
          chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks);
      };

      const first = await collect();
      const second = await collect();

      expect(first.equals(second)).toBe(true);
    });
  });

  describe('buildSyntheticPart', () => {
    it('returns a buffer with exactly the requested size', () => {
      const part = buildSyntheticPart(2, 5 * 1024 * 1024);
      expect(part.length).toBe(5 * 1024 * 1024);
    });

    it('produces deterministic content across executions', () => {
      const first = buildSyntheticPart(3, 8192);
      const second = buildSyntheticPart(3, 8192);
      expect(first.equals(second)).toBe(true);
    });
  });
});
