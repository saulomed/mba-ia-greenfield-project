import type { Queue } from 'bullmq';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer.enqueueProcessing', () => {
  it('adds a process job with jobId = videoId and the retry/backoff policy', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const producer = new VideoProcessingProducer({ add } as unknown as Queue);

    await producer.enqueueProcessing('video-id-1');

    expect(add).toHaveBeenCalledWith(
      'process',
      { videoId: 'video-id-1' },
      {
        jobId: 'video-id-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
      },
    );
  });
});
