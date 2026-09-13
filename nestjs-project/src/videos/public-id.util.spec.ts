import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('should generate an id of the requested length (default 11)', () => {
    expect(generatePublicId()).toHaveLength(11);
    expect(generatePublicId(20)).toHaveLength(20);
  });

  it('should only use characters from the base62 alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId()).toMatch(/^[0-9A-Za-z]+$/);
    }
  });

  it('should generate 10,000 ids without collision', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      ids.add(generatePublicId());
    }
    expect(ids.size).toBe(10000);
  });

  it('should distribute characters without gross bias', () => {
    const SAMPLES = 31000;
    const EXPECTED_PER_CHAR = SAMPLES / 62;
    const counts = new Map<string, number>();

    for (let i = 0; i < SAMPLES; i++) {
      const char = generatePublicId(1);
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }

    expect(counts.size).toBe(62);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(EXPECTED_PER_CHAR * 0.5);
      expect(count).toBeLessThan(EXPECTED_PER_CHAR * 1.5);
    }
  });
});
