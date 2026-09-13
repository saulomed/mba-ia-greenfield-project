import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer.enqueueProcessing', () => {
  it('adds a process job with jobId = videoId and the retry/backoff policy', async () => {
    const processingQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    } as any;
    const producer = new VideoProcessingProducer(processingQueue);

    await producer.enqueueProcessing('video-id-1');

    expect(processingQueue.add).toHaveBeenCalledWith(
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
