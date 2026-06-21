import { BalanceService } from '../../src/balances/balance.service';
import { OutboxStatus, RequestStatus } from '../../src/common/enums';
import { OutboxMessage } from '../../src/database/entities';
import { OutboxService } from '../../src/outbox/outbox.service';
import { TimeOffService } from '../../src/time-off/time-off.service';
import { DataSource } from 'typeorm';
import { createTestApp, TestContext } from '../utils/test-app';

const OutboxServiceMaxAttempts = OutboxService.MAX_ATTEMPTS;

/**
 * Reliable, exactly-once propagation under an unreliable HCM (TRD §5.2/§5.3,
 * C4/C6/C10). The approval is durable instantly; delivery survives transient
 * failure and an authoritative rejection releases the hold.
 */
describe('outbox resilience (integration)', () => {
  let ctx: TestContext;
  let timeOff: TimeOffService;
  let balances: BalanceService;
  let ds: DataSource;

  beforeEach(async () => {
    ctx = await createTestApp();
    timeOff = ctx.app.get(TimeOffService);
    balances = ctx.app.get(BalanceService);
    ds = ctx.app.get(DataSource);
    ctx.hcm.seed('e1', 'l1', 10);
  });
  afterEach(() => ctx.close());

  const approved = async (days = 2) => {
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

  it('approve succeeds instantly even while HCM is down; drains when it recovers (C4/C10)', async () => {
    // HCM will fail the first 3 delivery attempts, then succeed.
    ctx.hcm.configureFaults({ failuresToInject: 3 });
    const r = await approved();

    // First drain: HCM unavailable → request stays APPROVED, message FAILED w/ backoff.
    await ctx.outbox.drainOnce();
    expect((await timeOff.getOrThrow(r.id)).status).toBe(RequestStatus.APPROVED);

    // Advance the processor clock past each (growing) backoff and keep draining.
    for (let i = 0; i < 6; i++) {
      ctx.outbox.now = () => new Date(Date.now() + 60_000 * (i + 1));
      await ctx.outbox.drainOnce();
    }

    expect((await timeOff.getOrThrow(r.id)).status).toBe(RequestStatus.COMMITTED);
    expect(ctx.hcm.getBalance('e1', 'l1').balance).toBe(8);
  });

  it('retries do not double-debit HCM (idempotency, C6)', async () => {
    ctx.hcm.configureFaults({ failuresToInject: 2 });
    const r = await approved(3);
    for (let i = 0; i < 5; i++) {
      ctx.outbox.now = () => new Date(Date.now() + 60_000 * (i + 1));
      await ctx.outbox.drainOnce();
    }
    expect((await timeOff.getOrThrow(r.id)).status).toBe(RequestStatus.COMMITTED);
    expect(ctx.hcm.getBalance('e1', 'l1').balance).toBe(7); // debited once, not 3×
  });

  it('an authoritative HCM rejection fails the request and restores the balance', async () => {
    const r = await approved(2);
    expect((await balances.getView('e1', 'l1')).available).toBe(8); // reserved while approved

    // Now HCM rejects the debit as invalid dimensions (authoritative, non-retryable).
    ctx.hcm.configureFaults({ invalidDimensions: ['e1|l1'] });
    await ctx.outbox.drainOnce();

    expect((await timeOff.getOrThrow(r.id)).status).toBe(RequestStatus.FAILED);
    // Hold released → balance restored; HCM never changed.
    expect((await balances.getView('e1', 'l1')).available).toBe(10);
    ctx.hcm.configureFaults({ invalidDimensions: [] }); // clear so we can read HCM directly
    expect(ctx.hcm.getBalance('e1', 'l1').balance).toBe(10);

    const msgs = await ds.getRepository(OutboxMessage).find({ where: { requestId: r.id } });
    expect(msgs[0].status).toBe(OutboxStatus.DEAD);
  });

  it('parks a message as DEAD after exhausting retries (poison message)', async () => {
    ctx.hcm.configureFaults({ failuresToInject: 999 }); // never recovers
    const r = await approved(2);
    for (let i = 0; i < OutboxServiceMaxAttempts + 2; i++) {
      ctx.outbox.now = () => new Date(Date.now() + 3_600_000 * (i + 1));
      await ctx.outbox.drainOnce();
    }
    const msgs = await ds.getRepository(OutboxMessage).find({ where: { requestId: r.id } });
    expect(msgs[0].status).toBe(OutboxStatus.DEAD);
    expect(msgs[0].attempts).toBe(OutboxServiceMaxAttempts);
    // Request remains APPROVED (hold retained) for human intervention — not silently lost.
    expect((await timeOff.getOrThrow(r.id)).status).toBe(RequestStatus.APPROVED);
  });

  it('the approval + outbox message are written atomically', async () => {
    const r = await approved(2);
    const msgs = await ds.getRepository(OutboxMessage).find({ where: { requestId: r.id } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].idempotencyKey).toBe(`debit:${r.id}`);
    expect(msgs[0].status).toBe(OutboxStatus.PENDING);
  });
});
