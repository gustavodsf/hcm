import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance, BalanceLedgerEntry } from '../database/entities';
import { BalanceService } from './balance.service';
import { BalancesController } from './balances.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Balance, BalanceLedgerEntry])],
  providers: [BalanceService],
  controllers: [BalancesController],
  exports: [BalanceService],
})
export class BalancesModule {}
