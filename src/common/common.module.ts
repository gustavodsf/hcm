import { Global, Module } from '@nestjs/common';
import { KeyedMutex } from './keyed-mutex';

/**
 * Provides the single shared KeyedMutex so the reserve path (TimeOffService)
 * and the reconciliation path (SyncService) serialize on the SAME per-(emp,loc)
 * lock. A separate instance per module would defeat the guarantee.
 */
@Global()
@Module({
  providers: [KeyedMutex],
  exports: [KeyedMutex],
})
export class CommonModule {}
