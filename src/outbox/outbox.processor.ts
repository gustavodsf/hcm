import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { BalanceService } from '../balances/balance.service';
import { OutboxType, ReconciliationEventType, RequestStatus } from '../common/enums';
import { RequestAction, nextState } from '../common/state-machine';
import { OutboxMessage, ReconciliationEvent, TimeOffRequest } from '../database/entities';
import { HCM_CLIENT, IHcmClient } from '../hcm/hcm-client.interface';
import { HcmRejection } from '../hcm/hcm-core';
import { OutboxService } from './outbox.service';

/**
 * Delivers outbox messages to HCM and applies the outcome to the request +
 * ledger (TRD §5.2). Idempotent and restart-safe: a crash mid-delivery leaves
 * the message reclaimable; HCM dedupes replays by idempotency key (C6, C10).
 *
 * Background draining is gated by OUTBOX_AUTODRAIN so tests can drive
 * `drainOnce()` deterministically.
 */
@Injectable()
export class OutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxProcessor.name);
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  /** Injectable clock (overridable in tests for backoff timing). */
  now: () => Date = () => new Date();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(HCM_CLIENT) private readonly hcm: IHcmClient,
    private readonly outbox: OutboxService,
    private readonly balances: BalanceService,
  ) {}

  onModuleInit(): void {
    if (process.env.OUTBOX_AUTODRAIN !== 'false') {
      const intervalMs = Number(process.env.OUTBOX_INTERVAL_MS ?? 500);
      this.timer = setInterval(() => {
        this.drainOnce().catch((e) => this.logger.error(`drain error: ${e}`));
      }, intervalMs);
      // Don't keep the event loop alive solely for this timer.
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Process all currently-due messages once. Returns the count processed.
   * Re-entrancy guarded so overlapping ticks don't double-claim.
   */
  async drainOnce(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      const due = await this.outbox.claimDue(this.now());
      let processed = 0;
      for (const msg of due) {
        await this.deliver(msg);
        processed += 1;
      }
      return processed;
    } finally {
      this.draining = false;
    }
  }

  private async deliver(msg: OutboxMessage): Promise<void> {
    try {
      const ack = await this.hcm.applyDelta({
        employeeId: msg.payload.employeeId,
        locationId: msg.payload.locationId,
        amount: msg.payload.amount,
        type: msg.type === OutboxType.DEBIT ? 'DEBIT' : 'CREDIT',
        idempotencyKey: msg.idempotencyKey,
      });
      await this.applySuccess(msg, ack.hcmRef, ack.version, ack.applied);
    } catch (err) {
      if (err instanceof HcmRejection) {
        await this.applyRejection(msg, err.message);
      } else {
        // Transient: schedule retry / DEAD. Request state is left untouched.
        await this.dataSource.transaction(async (m) => {
          await this.outbox.markRetryOrDead(m, msg, String((err as Error).message ?? err), this.now());
        });
      }
    }
  }

  private async applySuccess(
    msg: OutboxMessage,
    hcmRef: string,
    hcmVersion: number,
    hcmActuallyApplied: boolean,
  ): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const request = await m.findOne(TimeOffRequest, { where: { id: msg.requestId } });
      if (!request) {
        await this.outbox.markDone(m, msg.id);
        return;
      }

      if (msg.type === OutboxType.DEBIT) {
        await this.balances.commitReservation(
          m,
          request.id,
          request.employeeId,
          request.locationId,
          msg.payload.amount,
          hcmVersion,
        );
        const to = nextState(request.status, RequestAction.HCM_COMMITTED);
        if (to) {
          request.status = to;
          request.hcmRef = hcmRef;
          await m.save(request);
        }
        // C5: HCM claimed success but did not change its balance — record drift
        // so reconciliation/ops can catch the silent no-op rather than trusting 200.
        if (!hcmActuallyApplied) {
          await this.recordDrift(m, request, 'HCM acknowledged debit without applying it (ghost success)');
        }
      } else {
        // CREDIT reversal completed.
        await this.balances.releaseCommit(m, request.id);
        const to = nextState(request.status, RequestAction.HCM_CREDIT_DONE);
        if (to) {
          request.status = to;
          await m.save(request);
        }
      }

      await this.outbox.markDone(m, msg.id);
    });
  }

  private async applyRejection(msg: OutboxMessage, reason: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const request = await m.findOne(TimeOffRequest, { where: { id: msg.requestId } });
      if (request && msg.type === OutboxType.DEBIT) {
        await this.balances.releaseReservation(m, request.id);
        const to = nextState(request.status, RequestAction.HCM_REJECTED);
        if (to) {
          request.status = to;
          await m.save(request);
        }
      }
      // A rejected credit reversal needs human attention; leave request pending.
      await this.outbox.markRejected(m, msg.id, reason);
    });
  }

  private async recordDrift(
    m: import('typeorm').EntityManager,
    request: TimeOffRequest,
    detail: string,
  ): Promise<void> {
    await m.save(
      m.create(ReconciliationEvent, {
        id: uuid(),
        type: ReconciliationEventType.DRIFT_DETECTED,
        employeeId: request.employeeId,
        locationId: request.locationId,
        delta: 0,
        detail: { requestId: request.id, reason: detail },
      }),
    );
  }
}
