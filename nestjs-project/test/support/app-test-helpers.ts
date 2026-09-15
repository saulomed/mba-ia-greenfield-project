import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';

export interface E2eApp {
  app: INestApplication<App>;
  dataSource: DataSource;
  throttlerStorage: ThrottlerStorageService;
}

/**
 * Compiles AppModule and reproduces main.ts's global config (ValidationPipe,
 * DomainExceptionFilter, ValidationExceptionFilter), since
 * Test.createTestingModule() does not run main.ts itself.
 */
export async function bootstrapE2eApp(): Promise<E2eApp> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  const dataSource = moduleFixture.get(DataSource);
  const throttlerStorage =
    moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

  return { app, dataSource, throttlerStorage };
}
