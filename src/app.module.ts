import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalancesModule } from './balances/balances.module';
import { CommonModule } from './common/common.module';
import { buildTypeOrmOptions } from './database/database.module';
import { HcmModule } from './hcm/hcm.module';
import { HealthModule } from './health/health.module';
import { OutboxModule } from './outbox/outbox.module';
import { SyncModule } from './sync/sync.module';
import { TimeOffModule } from './time-off/time-off.module';

/**
 * Root module. Feature modules are independent of the DB wiring so the test
 * harness can re-compose them against an in-memory SQLite (test/utils).
 */
@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions()),
    CommonModule,
    HcmModule,
    BalancesModule,
    OutboxModule,
    TimeOffModule,
    SyncModule,
    HealthModule,
  ],
})
export class AppModule {}

/** Feature modules only (no DB), for the test harness to import. */
export const FEATURE_MODULES = [
  CommonModule,
  HcmModule,
  BalancesModule,
  OutboxModule,
  TimeOffModule,
  SyncModule,
  HealthModule,
];
