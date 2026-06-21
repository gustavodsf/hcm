import { BalanceService } from '../../src/balances/balance.service';
import { ReconciliationEventType } from '../../src/common/enums';
import { SyncService } from '../../src/sync/sync.service';
import { TimeOffService } from '../../src/time-off/time-off.service';
import { createTestApp, TestContext } from '../utils/test-app';

/**
 * Defensive correctness when HCM does NOT always report errors (TRD §6.5/§7.3,
 * C5, G5). "No error" is treated as necessary-but-not-sufficient: drift is
 * detected and surfaced rather than silently corrupting balances.
 */
describe('defensive: HCM that does not report errors (integration)', () => {
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

  const approve = async (days: number) => {
    const r = await timeOff.create({
      employeeId: 'e1',
      locationId: 'l1',
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      days,
      submit: true,
    });
    await timeOff.approve(r.id);
    return r;
  };

  it('our LOCAL pre-validation blocks an over-draw even though HCM would silently accept it', async () => {
    // Even with HCM willing to silently over-draw, we never let the employee
    // reserve beyond available locally (we are the guard HCM might not be).
    ctx.hcm.configureFaults({ silentOverdraw: true });
    const draft = await timeOff.create({
      employeeId: 'e1',
      locationId: 'l1',
      startDate: '2026-07-01',
      endDate: '2026-07-20',
      days: 99,
    });
    await expect(timeOff.submit(draft.id)).rejects.toMatchObject({});
    expect((await balances.getView('e1', 'l1')).available).toBe(10);
  });

  it('detects ghost-success (HCM acked without applying) as DRIFT and reconciles to truth (C5)', async () => {
    ctx.hcm.configureFaults({ ghostSuccess: true });
    const r = await approve(4);
    await ctx.outbox.drainOnce(); // request → COMMITTED, but HCM balance untouched

    expect((await timeOff.getOrThrow(r.id)).status).toBe('COMMITTED');
    // We recorded a drift event instead of trusting the bare success.
    const drift = await sync.listEvents(ReconciliationEventType.DRIFT_DETECTED);
    expect(drift.length).toBeGreaterThanOrEqual(1);

    // A later reconcile pulls HCM truth (still 10) and corrects our view: the
    // ghost debit is matched-away and available reflects HCM reality.
    await sync.reconcileAll();
    const view = await balances.getView('e1', 'l1');
    expect(view.hcmBalance).toBe(10);
  });

  it('silent over-draw surfaces as OVER_ALLOCATED on the next reconcile (C5/C9)', async () => {
    // Two approvals totaling more than the balance, with HCM silently allowing it.
    ctx.hcm.configureFaults({ silentOverdraw: true });
    // Bypass our own guard by approving sequentially within balance, then a
    // reconcile that reveals HCM went negative from an out-of-band debit.
    const r = await approve(6);
    await ctx.outbox.drainOnce(); // HCM 10→4
    // An external actor silently over-draws HCM to -2 (no error reported).
    ctx.hcm.configureFaults({ silentOverdraw: true });
    ctx.hcm.applyDelta({ employeeId: 'e1', locationId: 'l1', amount: 6, type: 'DEBIT', idempotencyKey: 'external-1' });
    expect(ctx.hcm.getBalance('e1', 'l1').balance).toBe(-2);

    const result = await sync.reconcileAll();
    expect(result.processed).toBe(1);
    const view = await balances.getView('e1', 'l1');
    expect(view.available).toBeLessThan(0);
    const events = await sync.listEvents(ReconciliationEventType.OVER_ALLOCATED);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(r.id).toBeTruthy();
  });
});
