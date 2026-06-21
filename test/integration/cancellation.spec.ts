import { BalanceService } from '../../src/balances/balance.service';
import { RequestStatus } from '../../src/common/enums';
import { IllegalTransitionError } from '../../src/common/errors';
import { TimeOffService } from '../../src/time-off/time-off.service';
import { createTestApp, TestContext } from '../utils/test-app';

/**
 * Cancellation, pre- and post-commit (TRD §3.3). Pre-commit releases the hold;
 * post-commit issues a compensating HCM credit (exactly once).
 */
describe('cancellation (integration)', () => {
  let ctx: TestContext;
  let timeOff: TimeOffService;
  let balances: BalanceService;

  beforeEach(async () => {
    ctx = await createTestApp();
    timeOff = ctx.app.get(TimeOffService);
    balances = ctx.app.get(BalanceService);
    ctx.hcm.seed('e1', 'l1', 10);
  });
  afterEach(() => ctx.close());

  const submit = (days = 2) =>
    timeOff.create({
      employeeId: 'e1',
      locationId: 'l1',
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      days,
      submit: true,
    });

  it('cancel before approval releases the hold', async () => {
    const r = await submit();
    await timeOff.cancel(r.id);
    expect((await timeOff.getOrThrow(r.id)).status).toBe(RequestStatus.CANCELLED);
    expect((await balances.getView('e1', 'l1')).available).toBe(10);
  });

  it('cancel after approval (pre-commit) releases hold and cancels the queued debit', async () => {
    const r = await submit();
    await timeOff.approve(r.id);
    await timeOff.cancel(r.id); // before draining the outbox

    expect((await timeOff.getOrThrow(r.id)).status).toBe(RequestStatus.CANCELLED);
    // Draining now must NOT debit HCM — the message was cancelled.
    await ctx.outbox.drainOnce();
    expect(ctx.hcm.getBalance('e1', 'l1').balance).toBe(10);
    expect((await balances.getView('e1', 'l1')).available).toBe(10);
  });

  it('cancel after commit issues a compensating credit (exactly once)', async () => {
    const r = await submit(3);
    await timeOff.approve(r.id);
    await ctx.outbox.drainOnce(); // COMMITTED, HCM 10→7

    const cancelling = await timeOff.cancel(r.id);
    expect(cancelling.status).toBe(RequestStatus.CANCELLATION_PENDING);

    await ctx.outbox.drainOnce(); // deliver the credit
    expect((await timeOff.getOrThrow(r.id)).status).toBe(RequestStatus.CANCELLED);
    expect(ctx.hcm.getBalance('e1', 'l1').balance).toBe(10); // credited back

    // Idempotent: re-draining doesn't credit twice.
    await ctx.outbox.drainOnce();
    expect(ctx.hcm.getBalance('e1', 'l1').balance).toBe(10);
    expect((await balances.getView('e1', 'l1')).available).toBe(10);
  });

  it('rejects an illegal transition (cancel an already-cancelled request)', async () => {
    const r = await submit();
    await timeOff.cancel(r.id);
    await expect(timeOff.cancel(r.id)).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});
