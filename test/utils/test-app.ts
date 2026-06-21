import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FEATURE_MODULES } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { buildTypeOrmOptions } from '../../src/database/database.module';
import { HcmCore } from '../../src/hcm/hcm-core';
import { OutboxProcessor } from '../../src/outbox/outbox.processor';

export interface TestContext {
  app: INestApplication;
  hcm: HcmCore;
  outbox: OutboxProcessor;
  close: () => Promise<void>;
}

/**
 * Boots the full Nest app against an in-memory SQLite and the in-process HCM
 * double (TRD §10.1/§10.3). Auto-draining is disabled so tests drive the
 * outbox deterministically via `outbox.drainOnce()`.
 */
export async function createTestApp(): Promise<TestContext> {
  process.env.OUTBOX_AUTODRAIN = 'false';
  delete process.env.HCM_BASE_URL; // force the in-process client

  const moduleRef = await Test.createTestingModule({
    imports: [TypeOrmModule.forRoot(buildTypeOrmOptions(':memory:')), ...FEATURE_MODULES],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();

  const hcm = app.get(HcmCore);
  const outbox = app.get(OutboxProcessor);

  return {
    app,
    hcm,
    outbox,
    close: async () => {
      await app.close();
    },
  };
}
