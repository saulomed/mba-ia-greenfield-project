import {
  buildNormalizeArgs,
  buildThumbnailArgs,
  shouldRemux,
  thumbnailTimestampSeconds,
  type MediaProbeResult,
} from './media.service';

function probe(overrides: Partial<MediaProbeResult> = {}): MediaProbeResult {
  return {
    duration_seconds: 2,
    width: 320,
    height: 240,
    video_codec: 'h264',
    audio_codec: 'aac',
    ...overrides,
  };
}

describe('shouldRemux', () => {
  it('remuxes h264 video with aac audio', () => {
    expect(shouldRemux(probe())).toBe(true);
  });

  it('remuxes h264 video with no audio track', () => {
    expect(shouldRemux(probe({ audio_codec: null }))).toBe(true);
  });

  it('transcodes a non-h264 video', () => {
    expect(shouldRemux(probe({ video_codec: 'hevc' }))).toBe(false);
  });

  it('transcodes h264 video with non-aac audio', () => {
    expect(shouldRemux(probe({ audio_codec: 'opus' }))).toBe(false);
  });
});

describe('buildNormalizeArgs', () => {
  it('uses -c copy when remuxing', () => {
    const args = buildNormalizeArgs('in.mkv', 'out.mp4', probe());

    expect(args).toEqual(expect.arrayContaining(['-c', 'copy']));
    expect(args).not.toEqual(expect.arrayContaining(['-c:v']));
  });

  it('transcodes to libx264/aac when codecs are incompatible', () => {
    const args = buildNormalizeArgs(
      'in.mkv',
      'out.mp4',
      probe({ video_codec: 'hevc' }),
    );

    expect(args).toEqual(
      expect.arrayContaining([
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
      ]),
    );
  });

  it('always includes -movflags +faststart', () => {
    expect(buildNormalizeArgs('in.mp4', 'out.mp4', probe())).toEqual(
      expect.arrayContaining(['-movflags', '+faststart']),
    );
    expect(
      buildNormalizeArgs('in.mp4', 'out.mp4', probe({ video_codec: 'vp9' })),
    ).toEqual(expect.arrayContaining(['-movflags', '+faststart']));
  });
});

describe('thumbnailTimestampSeconds', () => {
  it('caps at 1 second for videos of 2 seconds or longer', () => {
    expect(thumbnailTimestampSeconds(2)).toBe(1);
    expect(thumbnailTimestampSeconds(10)).toBe(1);
  });

  it('uses half the duration for short videos', () => {
    expect(thumbnailTimestampSeconds(0.5)).toBe(0.25);
  });
});

describe('buildThumbnailArgs', () => {
  it('seeks to the computed timestamp, extracts a single frame and caps width at 1280', () => {
    const args = buildThumbnailArgs('in.mp4', 'out.jpg', 2);

    expect(args).toEqual(
      expect.arrayContaining(['-ss', '1.000', '-frames:v', '1']),
    );
    expect(args.join(' ')).toContain('1280');
  });

  it('seeks to half the duration for a short video', () => {
    const args = buildThumbnailArgs('in.mp4', 'out.jpg', 0.5);

    expect(args).toEqual(expect.arrayContaining(['-ss', '0.250']));
  });
});
