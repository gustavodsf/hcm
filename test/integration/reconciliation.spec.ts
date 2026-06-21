import { BalanceService } from '../../src/balances/balance.service';
import { ReconciliationEventType } from '../../src/common/enums';
import { SyncService } from '../../src/sync/sync.service';
import { TimeOffService } from '../../src/time-off/time-off.service';
import { createTestApp, TestContext } from '../utils/test-app';

/**
 * Synchronization & reconciliation (TRD §7): independent HCM changes via
 * realtime webhook and batch corpus, idempotent ingestion (C7), stale-version
 * rejection (C8), and over-allocation surfacing (C9).
 */
describe('reconciliation (integration)', () => {
  let ctx: TestContext;
  let timeOff: TimeOffService;
  let balances: BalanceService;
  let sync: SyncService;

  beforeEach(async () => {
    ctx = await createTestApp();
    timeOff = ctx.app.get(TimeOffService);
    balances = ctx.app.get(BalanceService);
    sync = ctx.app.get(SyncService);
    ctx.hcm.seed('e1', 'l1', 10); // version 1
  });
  afterEach(() => ctx.close());

  it('absorbs an anniversary bonus via realtime webhook (C3)', async () => {
    await balances.getView('e1', 'l1'); // load snapshot at v1
    const hcmRow = ctx.hcm.adjust('e1', 'l1', 5); // HCM independently +5 → v2

    const result = await sync.ingestRealtime({
      employeeId: 'e1',
      locationId: 'l1',
      balance: hcmRow.balance,
      version: hcmRow.version,
    });
    expect(result.eventType).toBe(ReconciliationEventType.BALANCE_INCREASED);
    expect((await balances.getView('e1', 'l1')).available).toBe(15);

    const events = await sync.listEvents(ReconciliationEventType.BALANCE_INCREASED);
    expect(events).toHaveLength(1);
  });

  it('an in-flight reservation is unaffected by an anniversary bonus mid-flight', async () => {
    const req = await timeOff.create({
      employeeId: 'e1',
      locationId: 'l1',
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      days: 3,
      submit: true,
    });
    const row = ctx.hcm.adjust('e1', 'l1', 5); // bonus while pending
    await sync.ingestRealtime({ employeeId: 'e1', locationId: 'l1', balance: row.balance, version: row.version });

    const view = await balances.getView('e1', 'l1');
    expect(view.available).toBe(12); // 15 − 3 still reserved
    expect((await timeOff.getOrThrow(req.id)).status).toBe('PENDING_APPROVAL');
  });

  it('ingests the full corpus and is idempotent on replay (C7)', async () => {
    ctx.hcm.seed('e2', 'l1', 7);
    const corpus = ctx.hcm.dumpCorpus();

    const first = await sync.ingestBatch(corpus);
    expect(first.processed).toBe(2);

    // Replaying the SAME corpus (same versions) applies nothing new.
    const replay = await sync.ingestBatch(corpus);
    expect(replay.applied).toBe(0);

    expect((await balances.getView('e2', 'l1')).available).toBe(7);
  });

  it('does not double-count our own committed debit when the batch arrives (C7)', async () => {
    const req = await timeOff.create({
      employeeId: 'e1',
      locationId: 'l1',
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      days: 4,
      submit: true,
    });
    await timeOff.approve(req.id);
    await ctx.outbox.drainOnce(); // HCM debited 10→6 (v2); local commit pending

    // HCM pushes a corpus that ALREADY reflects the debit.
    await sync.ingestBatch(ctx.hcm.dumpCorpus());

    const view = await balances.getView('e1', 'l1');
    expect(view.hcmBalance).toBe(6);
    expect(view.committedPending).toBe(0); // matched & dropped, not subtracted again
    expect(view.available).toBe(6); // NOT 2 (would be the double-count bug)
  });

  it('rejects a stale (older-version) update after a newer one (C8)', async () => {
    const newer = ctx.hcm.adjust('e1', 'l1', 5); // v2, balance 15
    await sync.ingestRealtime({ employeeId: 'e1', locationId: 'l1', balance: newer.balance, version: newer.version });

    // A delayed webhook carrying the OLD v1 value arrives late.
    const stale = await sync.ingestRealtime({ employeeId: 'e1', locationId: 'l1', balance: 10, version: 1 });
    expect(stale.applied).toBe(false);
    expect((await balances.getView('e1', 'l1')).available).toBe(15); // unchanged
  });

  it('surfaces OVER_ALLOCATED when HCM drops below outstanding reservations (C9)', async () => {
    await timeOff.create({
      employeeId: 'e1',
      locationId: 'l1',
      startDate: '2026-07-01',
      endDate: '2026-07-10',
      days: 8,
      submit: true,
    });
    // HR cuts the HCM balance to 5 (below the 8 reserved).
    const row = ctx.hcm.seed('e1', 'l1', 5); // bumps version
    const result = await sync.ingestRealtime({ employeeId: 'e1', locationId: 'l1', balance: 5, version: row.version });

    expect(result.eventType).toBe(ReconciliationEventType.OVER_ALLOCATED);
    expect((await balances.getView('e1', 'l1')).available).toBe(-3);

    const events = await sync.listEvents(ReconciliationEventType.OVER_ALLOCATED);
    expect(events).toHaveLength(1); // raised for human resolution, no request destroyed
  });

  it('reconcileAll re-pulls every known balance from HCM (safety net §7.4)', async () => {
    await balances.getView('e1', 'l1');
    ctx.hcm.adjust('e1', 'l1', 9); // change HCM without notifying us
    const { processed } = await sync.reconcileAll();
    expect(processed).toBe(1);
    expect((await balances.getView('e1', 'l1')).available).toBe(19);
  });
});
