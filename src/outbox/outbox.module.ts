import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalancesModule } from '../balances/balances.module';
import { OutboxMessage, ReconciliationEvent, TimeOffRequest } from '../database/entities';
import { OutboxProcessor } from './outbox.processor';
import { OutboxService } from './outbox.service';

/**
 * Owns reliable propagation to HCM. Depends on BalancesModule (to move the
 * ledger on commit/credit) but NOT on TimeOffModule, keeping the graph acyclic
 * (TimeOff → Outbox, Outbox → Balances).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OutboxMessage, TimeOffRequest, ReconciliationEvent]),
    BalancesModule,
  ],
  providers: [OutboxService, OutboxProcessor],
  exports: [OutboxService, OutboxProcessor],
})
export class OutboxModule {}
