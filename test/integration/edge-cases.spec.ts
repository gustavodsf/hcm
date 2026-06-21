import { DataSource } from 'typeorm';
import { BalanceService } from '../../src/balances/balance.service';
import { ReconciliationEventType } from '../../src/common/enums';
import { IllegalTransitionError } from '../../src/common/errors';
import { TimeOffRequest } from '../../src/database/entities';
import { SyncService } from '../../src/sync/sync.service';
import { TimeOffService } from '../../src/time-off/time-off.service';
import { createTestApp, TestContext } from '../utils/test-app';

/** Edge/illegal-transition and sync-bootstrap branches (TRD §3.3, §7). */
describe('edge cases (integration)', () => {
  let ctx: TestContext;
  let timeOff: TimeOffService;
  let balances: BalanceService;
  let sync: SyncService;

  beforeEach(async () => {
    ctx = await createTestApp();
    timeOff = ctx.app.get(TimeOffService);
    balances = ctx.app.get(BalanceService);
    sync = ctx.app.get(SyncService);
    ctx.hcm.seed('e1', 'l1', 10);
  });
  afterEach(() => ctx.close());

  const submit = () =>
    timeOff.create({
      employeeId: 'e1',
      locationId: 'l1',
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      days: 2,
      submit: true,
    });

  it('submitting an already-submitted request is illegal', async () => {
    const r = await submit();
    await expect(timeOff.submit(r.id)).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('approving a committed request is illegal', async () => {
    const r = await submit();
    await timeOff.approve(r.id);
    await ctx.outbox.drainOnce();
    await expect(timeOff.approve(r.id)).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('rejecting a draft (no reservation) is illegal', async () => {
    const draft = await timeOff.create({
      employeeId: 'e1',
      locationId: 'l1',
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      days: 1,
    });
    await expect(timeOff.reject(draft.id)).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('realtime ingest can bootstrap a brand-new (emp,loc) with an explicit asOf', async () => {
    const result = await sync.ingestRealtime({
      employeeId: 'eNew',
      locationId: 'lNew',
      balance: 12,
      version: 3,
      asOf: '2026-06-01T00:00:00.000Z',
    });
    expect(result.applied).toBe(true);
    expect(result.eventType).toBe(ReconciliationEventType.BALANCE_INCREASED);
    const view = await balances.getView('eNew', 'lNew');
    expect(view.available).toBe(12);
  });

  it('outbox delivery tolerates a vanished request (marks message done, no crash)', async () => {
    const r = await submit();
    await timeOff.approve(r.id);
    // Simulate the request row disappearing before delivery (e.g. external purge).
    const ds = ctx.app.get(DataSource);
    await ds.getRepository(TimeOffRequest).delete({ id: r.id });
    await expect(ctx.outbox.drainOnce()).resolves.toBe(1); // does not throw
  });

  it('getViewsForEmployee aggregates across locations including committed holds', async () => {
    ctx.hcm.seed('e1', 'l2', 6);
    const r = await submit(); // reserve 2 at l1
    await timeOff.approve(r.id);
    await ctx.outbox.drainOnce(); // commit at l1
    await balances.getView('e1', 'l2'); // load l2

    const views = await balances.getViewsForEmployee('e1');
    const byLoc = Object.fromEntries(views.map((v) => [v.locationId, v.available]));
    expect(byLoc['l1']).toBe(8); // 10 − 2 committed
    expect(byLoc['l2']).toBe(6);
  });
});
