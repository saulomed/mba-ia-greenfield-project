import { ALL_VIDEO_FIXTURES, getVideoFixture } from './video-fixtures';

export default async function globalSetup(): Promise<void> {
  await Promise.all(ALL_VIDEO_FIXTURES.map((name) => getVideoFixture(name)));
}
