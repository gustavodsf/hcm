import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance, BalanceLedgerEntry, ReconciliationEvent } from '../database/entities';
import { OutboxModule } from '../outbox/outbox.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Balance, BalanceLedgerEntry, ReconciliationEvent]),
    OutboxModule,
  ],
  providers: [SyncService],
  controllers: [SyncController],
  exports: [SyncService],
})
export class SyncModule {}
