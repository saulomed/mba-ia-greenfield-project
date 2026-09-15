import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getVideoFixture, type VideoFixtureName } from '../test/video-fixtures';
import { InvalidMediaError } from './media.exceptions';
import { MediaService } from './media.service';

describe('MediaService (integration)', () => {
  let service: MediaService;
  let tmpDir: string;

  beforeAll(() => {
    service = new MediaService();
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'media-service-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('probe', () => {
    const cases: Array<{
      fixture: VideoFixtureName;
      video_codec: string;
      audio_codec: string | null;
    }> = [
      {
        fixture: 'mp4-h264-aac-faststart',
        video_codec: 'h264',
        audio_codec: 'aac',
      },
      {
        fixture: 'mp4-h264-aac-no-faststart',
        video_codec: 'h264',
        audio_codec: 'aac',
      },
      { fixture: 'mkv-hevc-aac', video_codec: 'hevc', audio_codec: 'aac' },
      { fixture: 'webm-vp9-opus', video_codec: 'vp9', audio_codec: 'opus' },
      { fixture: 'mp4-video-only', video_codec: 'h264', audio_codec: null },
    ];

    it.each(cases)(
      'probes $fixture as $video_codec/$audio_codec',
      async ({ fixture, video_codec, audio_codec }) => {
        const filePath = await getVideoFixture(fixture);

        const result = await service.probe(filePath);

        expect(result.duration_seconds).toBeGreaterThan(1.9);
        expect(result.duration_seconds).toBeLessThan(2.1);
        expect(result.width).toBe(320);
        expect(result.height).toBe(240);
        expect(result.video_codec).toBe(video_codec);
        expect(result.audio_codec).toBe(audio_codec);
      },
    );

    it('throws InvalidMediaError for a truncated file', async () => {
      const filePath = await getVideoFixture('truncated');

      await expect(service.probe(filePath)).rejects.toThrow(InvalidMediaError);
    });
  });

  describe('normalize', () => {
    it('transcodes mkv-hevc-aac into an MP4 with h264/aac', async () => {
      const inputPath = await getVideoFixture('mkv-hevc-aac');
      const probeResult = await service.probe(inputPath);
      const outputPath = path.join(tmpDir, 'normalized.mp4');

      await service.normalize(inputPath, outputPath, probeResult);
      const outputProbe = await service.probe(outputPath);

      expect(outputProbe.video_codec).toBe('h264');
      expect(outputProbe.audio_codec).toBe('aac');
    }, 15000);

    it('produces a faststart MP4 (moov before mdat) from a non-faststart source', async () => {
      const inputPath = await getVideoFixture('mp4-h264-aac-no-faststart');
      const probeResult = await service.probe(inputPath);
      const outputPath = path.join(tmpDir, 'faststart.mp4');

      await service.normalize(inputPath, outputPath, probeResult);

      const bytes = await readFile(outputPath);
      const moovIndex = bytes.indexOf('moov');
      const mdatIndex = bytes.indexOf('mdat');

      expect(moovIndex).toBeGreaterThan(-1);
      expect(mdatIndex).toBeGreaterThan(-1);
      expect(moovIndex).toBeLessThan(mdatIndex);
    }, 15000);
  });

  describe('extractThumbnail', () => {
    it('produces a readable JPEG thumbnail', async () => {
      const inputPath = await getVideoFixture('mp4-h264-aac-faststart');
      const outputPath = path.join(tmpDir, 'thumb.jpg');

      await service.extractThumbnail(inputPath, outputPath, 2);

      const bytes = await readFile(outputPath);
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
    });
  });
});
