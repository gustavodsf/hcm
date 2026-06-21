import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalancesModule } from '../balances/balances.module';
import { TimeOffRequest } from '../database/entities';
import { OutboxModule } from '../outbox/outbox.module';
import { TimeOffController } from './time-off.controller';
import { TimeOffService } from './time-off.service';

// KeyedMutex is provided globally by CommonModule so the reserve and
// reconciliation paths share one lock instance.
@Module({
  imports: [TypeOrmModule.forFeature([TimeOffRequest]), BalancesModule, OutboxModule],
  providers: [TimeOffService],
  controllers: [TimeOffController],
  exports: [TimeOffService],
})
export class TimeOffModule {}
