import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { createS3Client } from './create-s3-client';
import { StorageBootstrapService } from './storage-bootstrap.service';
import { STORAGE_CLIENT, STORAGE_PRESIGN_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

@Module({
  providers: [
    {
      provide: STORAGE_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        createS3Client(config, config.endpoint),
    },
    {
      provide: STORAGE_PRESIGN_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        createS3Client(config, config.publicEndpoint),
    },
    StorageService,
    StorageBootstrapService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
