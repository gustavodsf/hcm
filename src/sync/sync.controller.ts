import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReconciliationEventType } from '../common/enums';
import { OutboxProcessor } from '../outbox/outbox.processor';
import { HcmBalanceUpdateDto, HcmBatchDto } from './dto/sync.dto';
import { SyncService } from './sync.service';

/** HCM-facing sync + ops endpoints (TRD §8.3). */
@ApiTags('sync')
@Controller('v1')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly outbox: OutboxProcessor,
  ) {}

  @Post('sync/hcm/balance')
  @HttpCode(200)
  @ApiOperation({ summary: 'Realtime single-key balance webhook from HCM' })
  ingestRealtime(@Body() dto: HcmBalanceUpdateDto) {
    return this.sync.ingestRealtime(dto);
  }

  @Post('sync/hcm/batch')
  @HttpCode(200)
  @ApiOperation({ summary: 'Full corpus ingest from HCM (idempotent)' })
  ingestBatch(@Body() dto: HcmBatchDto) {
    return this.sync.ingestBatch(dto.balances);
  }

  @Post('sync/reconcile')
  @HttpCode(200)
  @ApiOperation({ summary: 'Trigger safety-net reconcile (re-pull all from HCM)' })
  reconcile() {
    return this.sync.reconcileAll();
  }

  @Get('sync/events')
  @ApiOperation({ summary: 'Inspect reconciliation / drift / over-allocation events' })
  events(@Query('type') type?: ReconciliationEventType) {
    return this.sync.listEvents(type);
  }

  @Post('internal/outbox/drain')
  @HttpCode(200)
  @ApiOperation({ summary: 'Force outbox delivery (ops/test determinism)' })
  async drain() {
    const processed = await this.outbox.drainOnce();
    return { processed };
  }
}
