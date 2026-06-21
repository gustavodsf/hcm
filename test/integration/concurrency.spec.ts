import { RequestStatus } from '../../src/common/enums';
import { BalanceService } from '../../src/balances/balance.service';
import { TimeOffService } from '../../src/time-off/time-off.service';
import { createTestApp, TestContext } from '../utils/test-app';

/**
 * Concurrency / no-double-spend (TRD §6.2, C2). The reserve critical section
 * is serialized per (employeeId, locationId), so racing submits can never both
 * consume the same headroom.
 */
describe('concurrent reservations (integration)', () => {
  let ctx: TestContext;
  let timeOff: TimeOffService;
  let balances: BalanceService;

  beforeEach(async () => {
    ctx = await createTestApp();
    timeOff = ctx.app.get(TimeOffService);
    balances = ctx.app.get(BalanceService);
  });
  afterEach(() => ctx.close());

  const draft = (days: number) =>
    timeOff.create({
      employeeId: 'e1',
      locationId: 'l1',
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      days,
    });

  it('two submits racing for a balance that covers only one: exactly one wins', async () => {
    ctx.hcm.seed('e1', 'l1', 5);
    const a = await draft(5);
    const b = await draft(5);

    const results = await Promise.allSettled([timeOff.submit(a.id), timeOff.submit(b.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser is a 409 INSUFFICIENT_BALANCE.
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err.getResponse().error).toBe('INSUFFICIENT_BALANCE');

    const view = await balances.getView('e1', 'l1');
    expect(view.available).toBe(0); // exactly one 5-day hold
    expect(view.available).toBeGreaterThanOrEqual(0);
  });

  it('N concurrent 1-day submits against a balance of K reserve exactly K', async () => {
    ctx.hcm.seed('e1', 'l1', 4);
    const drafts = await Promise.all([draft(1), draft(1), draft(1), draft(1), draft(1), draft(1)]);

    const results = await Promise.allSettled(drafts.map((d) => timeOff.submit(d.id)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(4); // only 4 of 6 fit

    const view = await balances.getView('e1', 'l1');
    expect(view.reservedOpen).toBe(4);
    expect(view.available).toBe(0);

    const pending = await timeOff.list({ employeeId: 'e1', status: RequestStatus.PENDING_APPROVAL });
    expect(pending).toHaveLength(4);
  });
});
