import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { LedgerPhase, LedgerState, ReconciliationEventType } from '../common/enums';
import { KeyedMutex } from '../common/keyed-mutex';
import { CommittedEntry, ReconcileResult, reconcile } from '../common/reconciliation-math';
import { Balance, BalanceLedgerEntry, ReconciliationEvent } from '../database/entities';
import { HCM_CLIENT, IHcmClient } from '../hcm/hcm-client.interface';

export interface HcmBalanceUpdate {
  employeeId: string;
  locationId: string;
  balance: number;
  version: number;
  asOf?: string;
}

const balanceKey = (e: string, l: string) => `${e}|${l}`;

/**
 * The reconciliation engine (TRD §7). Absorbs independent HCM changes from two
 * channels — realtime webhook and batch corpus — into our cached snapshot, then
 * re-derives available balance without double-counting our own in-flight
 * commits (C7) and surfaces over-allocations / drift for ops (C5, C9).
 *
 * Reconciliation for a key shares the SAME per-(emp,loc) mutex as the reserve
 * path so a snapshot swap can't interleave with a reservation read-modify-write.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(HCM_CLIENT) private readonly hcm: IHcmClient,
    private readonly mutex: KeyedMutex,
  ) {}

  /** Realtime single-key webhook (TRD §7.1). */
  async ingestRealtime(update: HcmBalanceUpdate): Promise<ReconcileResult> {
    return this.reconcileKey(update);
  }

  /** Full corpus ingest; reconciles each row idempotently (TRD §7.2). */
  async ingestBatch(rows: HcmBalanceUpdate[]): Promise<{ processed: number; applied: number; overAllocated: number }> {
    let applied = 0;
    let overAllocated = 0;
    for (const row of rows) {
      const result = await this.reconcileKey(row);
      if (result.applied) applied += 1;
      if (result.eventType === ReconciliationEventType.OVER_ALLOCATED) overAllocated += 1;
    }
    return { processed: rows.length, applied, overAllocated };
  }

  /**
   * Safety-net reconcile (TRD §7.4): re-pull every known balance from HCM's
   * realtime API and reconcile. Catches anything a dropped webhook missed.
   */
  async reconcileAll(): Promise<{ processed: number }> {
    const balances = await this.dataSource.getRepository(Balance).find();
    let processed = 0;
    for (const b of balances) {
      const row = await this.hcm.getBalance(b.employeeId, b.locationId);
      await this.reconcileKey({
        employeeId: b.employeeId,
        locationId: b.locationId,
        balance: row.balance,
        version: row.version,
        asOf: row.asOf,
      });
      processed += 1;
    }
    return { processed };
  }

  async listEvents(type?: ReconciliationEventType): Promise<ReconciliationEvent[]> {
    return this.dataSource.getRepository(ReconciliationEvent).find({
      where: type ? { type } : {},
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }

  /** Core per-key reconciliation, serialized against reservations via the mutex. */
  private async reconcileKey(update: HcmBalanceUpdate): Promise<ReconcileResult> {
    return this.mutex.runExclusive(balanceKey(update.employeeId, update.locationId), () =>
      this.dataSource.transaction(async (m) => {
        let balance = await m.findOne(Balance, {
          where: { employeeId: update.employeeId, locationId: update.locationId },
        });
        if (!balance) {
          balance = m.create(Balance, {
            employeeId: update.employeeId,
            locationId: update.locationId,
            hcmBalance: 0,
            lastReconciledVersion: 0,
            asOf: null,
          });
        }

        const reservedRows = await m.find(BalanceLedgerEntry, {
          where: {
            employeeId: update.employeeId,
            locationId: update.locationId,
            phase: LedgerPhase.RESERVE,
            state: LedgerState.ACTIVE,
          },
        });
        const reservedOpen = reservedRows.reduce((s, r) => s + r.amount, 0);

        const committedRows = await m.find(BalanceLedgerEntry, {
          where: {
            employeeId: update.employeeId,
            locationId: update.locationId,
            phase: LedgerPhase.COMMIT,
            state: LedgerState.ACTIVE,
          },
        });
        const committedEntries: CommittedEntry[] = committedRows.map((r) => ({
          id: r.id,
          amount: r.amount,
          hcmVersion: r.hcmVersion,
        }));

        const result = reconcile({
          currentHcmBalance: balance.hcmBalance,
          lastReconciledVersion: balance.lastReconciledVersion,
          reservedOpen,
          committedEntries,
          authoritativeBalance: update.balance,
          authoritativeVersion: update.version,
        });

        if (!result.applied) {
          return result; // stale; no-op (C8)
        }

        // Drop matched commits out of committedPending (C7).
        if (result.matchedCommitIds.length > 0) {
          await m.update(
            BalanceLedgerEntry,
            { id: In(result.matchedCommitIds) },
            { state: LedgerState.RECONCILED },
          );
        }

        balance.hcmBalance = result.newHcmBalance;
        balance.lastReconciledVersion = result.newLastReconciledVersion;
        balance.asOf = update.asOf ? new Date(update.asOf) : new Date();
        await m.save(balance);

        // Record an audit event for anything that changes what the employee sees,
        // or any over-allocation. Pure no-op reconciles aren't logged (noise).
        if (result.eventType !== ReconciliationEventType.RECONCILED) {
          await m.save(
            m.create(ReconciliationEvent, {
              id: uuid(),
              type: result.eventType,
              employeeId: update.employeeId,
              locationId: update.locationId,
              delta: result.delta,
              detail: {
                previousAvailable: result.previousAvailable,
                newAvailable: result.newAvailable,
                availableDelta: result.availableDelta,
                authoritativeVersion: update.version,
                matchedCommits: result.matchedCommitIds.length,
              },
            }),
          );
        }

        return result;
      }),
    );
  }
}
