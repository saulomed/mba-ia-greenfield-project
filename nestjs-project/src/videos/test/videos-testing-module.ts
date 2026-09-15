import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import databaseConfig from '../../config/database.config';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';

export const VIDEOS_TEST_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];

/**
 * ConfigModule + TypeOrmModule.forRootAsync imports shared by VideosModule's
 * own unit/integration tests, which need real config namespaces and a real
 * DataSource (VideosModule is not self-contained like WorkerModule).
 */
export function videosTestingModuleImports() {
  return [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig, videoConfig],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        entities: VIDEOS_TEST_ENTITIES,
        synchronize: true,
      }),
    }),
  ];
}
