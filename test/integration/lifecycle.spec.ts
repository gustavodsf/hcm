import { BalanceService } from '../../src/balances/balance.service';
import { RequestStatus } from '../../src/common/enums';
import { TimeOffService } from '../../src/time-off/time-off.service';
import { createTestApp, TestContext } from '../utils/test-app';

/**
 * Happy-path lifecycle: create → submit (reserve) → approve (enqueue) → drain
 * (commit to HCM). Asserts the request reaches COMMITTED, HCM is debited
 * exactly once, and the derived balance is correct throughout (TRD §3.3, §6).
 */
describe('time-off lifecycle (integration)', () => {
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

  const dto = (overrides = {}) => ({
    employeeId: 'e1',
    locationId: 'l1',
    startDate: '2026-07-01',
    endDate: '2026-07-02',
    days: 2,
    ...overrides,
  });

  it('reserves on submit, reducing available but not the HCM balance', async () => {
    const req = await timeOff.create(dto({ submit: true }));
    expect(req.status).toBe(RequestStatus.PENDING_APPROVAL);

    const view = await balances.getView('e1', 'l1');
    expect(view.available).toBe(8); // 10 − 2 reserved
    expect(view.reservedOpen).toBe(2);
    expect(ctx.hcm.getBalance('e1', 'l1').balance).toBe(10); // HCM untouched until commit
  });

  it('commits to HCM on approve+drain, exactly once', async () => {
    const req = await timeOff.create(dto({ submit: true }));
    await timeOff.approve(req.id);

    const processed = await ctx.outbox.drainOnce();
    expect(processed).toBe(1);

    const after = await timeOff.getOrThrow(req.id);
    expect(after.status).toBe(RequestStatus.COMMITTED);
    expect(after.hcmRef).toBeTruthy();
    expect(ctx.hcm.getBalance('e1', 'l1').balance).toBe(8); // debited once

    const view = await balances.getView('e1', 'l1');
    expect(view.available).toBe(8);

    // Draining again must NOT double-debit (outbox message is DONE).
    await ctx.outbox.drainOnce();
    expect(ctx.hcm.getBalance('e1', 'l1').balance).toBe(8);
  });

  it('create is idempotent on Idempotency-Key', async () => {
    const a = await timeOff.create(dto(), 'key-123');
    const b = await timeOff.create(dto(), 'key-123');
    expect(b.id).toBe(a.id);
    const all = await timeOff.list({ employeeId: 'e1' });
    expect(all).toHaveLength(1);
  });

  it('reject releases the reservation', async () => {
    const req = await timeOff.create(dto({ submit: true }));
    await timeOff.reject(req.id);
    expect((await timeOff.getOrThrow(req.id)).status).toBe(RequestStatus.REJECTED);
    expect((await balances.getView('e1', 'l1')).available).toBe(10);
  });
});
