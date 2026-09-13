import { Test } from '@nestjs/testing';
import { videosTestingModuleImports } from './test/videos-testing-module';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('should compile with StorageModule, ChannelsModule and the registered queues', async () => {
    const module = await Test.createTestingModule({
      imports: [...videosTestingModuleImports(), VideosModule],
    }).compile();

    expect(module.get(VideosController)).toBeDefined();
    expect(module.get(VideosService)).toBeDefined();

    await module.close();
  }, 30000);
});
