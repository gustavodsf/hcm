import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { BalanceComponents, BalanceView, toView } from '../common/balance-math';
import { LedgerPhase, LedgerState } from '../common/enums';
import { Balance, BalanceLedgerEntry } from '../database/entities';
import { HCM_CLIENT, IHcmClient } from '../hcm/hcm-client.interface';

/**
 * Owns balance derivation and the ledger (TRD §6). The available balance is
 * NEVER stored; it is always computed from the cached HCM snapshot plus open
 * ledger entries, which is what makes double-spend / double-count structurally
 * impossible (I2).
 *
 * Transactional methods accept an EntityManager so they compose inside the
 * time-off and reconciliation transactions.
 */
@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(HCM_CLIENT) private readonly hcm: IHcmClient,
  ) {}

  /**
   * Ensure a local balance snapshot exists for (emp,loc), lazily pulling from
   * HCM's realtime API if we've never seen it (TRD §7.1). Done OUTSIDE the
   * reserve transaction so we never hold a write lock across a network call.
   */
  async ensureBalanceLoaded(employeeId: string, locationId: string): Promise<void> {
    const existing = await this.dataSource
      .getRepository(Balance)
      .findOne({ where: { employeeId, locationId } });
    if (existing) return;

    const row = await this.hcm.getBalance(employeeId, locationId);
    // Upsert; ignore race where a concurrent caller inserted first.
    await this.dataSource
      .getRepository(Balance)
      .createQueryBuilder()
      .insert()
      .values({
        employeeId,
        locationId,
        hcmBalance: row.balance,
        lastReconciledVersion: row.version,
        asOf: new Date(row.asOf),
      })
      .orIgnore()
      .execute();
  }

  /** Compute the live balance components for (emp,loc) within `manager`. */
  async computeComponents(
    manager: EntityManager,
    employeeId: string,
    locationId: string,
  ): Promise<BalanceComponents> {
    const balance = await manager.findOne(Balance, { where: { employeeId, locationId } });
    const hcmBalance = balance?.hcmBalance ?? 0;

    const rows = await manager
      .createQueryBuilder(BalanceLedgerEntry, 'l')
      .select('l.phase', 'phase')
      .addSelect('SUM(l.amount)', 'total')
      .where('l.employee_id = :employeeId AND l.location_id = :locationId', { employeeId, locationId })
      .andWhere('l.state = :active', { active: LedgerState.ACTIVE })
      .groupBy('l.phase')
      .getRawMany<{ phase: LedgerPhase; total: number }>();

    let reservedOpen = 0;
    let committedPending = 0;
    for (const r of rows) {
      const total = Number(r.total) || 0;
      if (r.phase === LedgerPhase.RESERVE) reservedOpen += total;
      else if (r.phase === LedgerPhase.COMMIT) committedPending += total;
    }
    return { hcmBalance, reservedOpen, committedPending };
  }

  /** Public read of the derived balance view (TRD §8.1). */
  async getView(employeeId: string, locationId: string): Promise<BalanceView> {
    await this.ensureBalanceLoaded(employeeId, locationId);
    const components = await this.dataSource.transaction((m) =>
      this.computeComponents(m, employeeId, locationId),
    );
    return toView(components);
  }

  async getViewsForEmployee(employeeId: string): Promise<(BalanceView & { locationId: string })[]> {
    const balances = await this.dataSource.getRepository(Balance).find({ where: { employeeId } });
    const views: (BalanceView & { locationId: string })[] = [];
    for (const b of balances) {
      const view = await this.getView(employeeId, b.locationId);
      views.push({ ...view, locationId: b.locationId });
    }
    return views;
  }

  // ---- Ledger mutations (transactional) -----------------------------------

  /** Insert an ACTIVE RESERVE hold. Caller has already checked availability. */
  async addReservation(
    manager: EntityManager,
    requestId: string,
    employeeId: string,
    locationId: string,
    amount: number,
  ): Promise<BalanceLedgerEntry> {
    const entry = manager.create(BalanceLedgerEntry, {
      id: uuid(),
      requestId,
      employeeId,
      locationId,
      amount,
      phase: LedgerPhase.RESERVE,
      state: LedgerState.ACTIVE,
    });
    return manager.save(entry);
  }

  /** Release a request's ACTIVE RESERVE hold (reject/cancel/fail). Idempotent. */
  async releaseReservation(manager: EntityManager, requestId: string): Promise<void> {
    await manager.update(
      BalanceLedgerEntry,
      { requestId, phase: LedgerPhase.RESERVE, state: LedgerState.ACTIVE },
      { state: LedgerState.RELEASED },
    );
  }

  /**
   * Move a request's RESERVE hold to a COMMIT entry once HCM acked the debit.
   * The RESERVE is released and a COMMIT entry created stamped with hcmVersion,
   * so reconciliation can later match it (TRD §7.2).
   */
  async commitReservation(
    manager: EntityManager,
    requestId: string,
    employeeId: string,
    locationId: string,
    amount: number,
    hcmVersion: number | null,
  ): Promise<void> {
    await this.releaseReservation(manager, requestId);
    const entry = manager.create(BalanceLedgerEntry, {
      id: uuid(),
      requestId,
      employeeId,
      locationId,
      amount,
      phase: LedgerPhase.COMMIT,
      state: LedgerState.ACTIVE,
      hcmVersion,
    });
    await manager.save(entry);
  }

  /** Release an ACTIVE COMMIT entry (compensating credit on cancel-after-commit). */
  async releaseCommit(manager: EntityManager, requestId: string): Promise<void> {
    await manager.update(
      BalanceLedgerEntry,
      { requestId, phase: LedgerPhase.COMMIT, state: LedgerState.ACTIVE },
      { state: LedgerState.RELEASED },
    );
  }
}
