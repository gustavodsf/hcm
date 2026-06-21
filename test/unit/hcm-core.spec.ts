import { HcmCore, HcmRejection, HcmUnavailable } from '../../src/hcm/hcm-core';

describe('HcmCore simulation engine (TRD §10.3)', () => {
  let core: HcmCore;
  beforeEach(() => {
    core = new HcmCore();
    core.seed('e1', 'l1', 10);
  });

  it('returns a seeded balance with a monotonic version', () => {
    const row = core.getBalance('e1', 'l1');
    expect(row.balance).toBe(10);
    expect(row.version).toBe(1);
  });

  it('applies a debit and bumps the version', () => {
    const ack = core.applyDelta({ employeeId: 'e1', locationId: 'l1', amount: 4, type: 'DEBIT', idempotencyKey: 'k1' });
    expect(ack.applied).toBe(true);
    expect(ack.balance).toBe(6);
    expect(core.getBalance('e1', 'l1').version).toBe(2);
  });

  it('is idempotent: replaying an idempotency key does not double-apply (C6)', () => {
    const cmd = { employeeId: 'e1', locationId: 'l1', amount: 4, type: 'DEBIT' as const, idempotencyKey: 'k1' };
    const first = core.applyDelta(cmd);
    const replay = core.applyDelta(cmd);
    expect(replay.replayed).toBe(true);
    expect(replay.hcmRef).toBe(first.hcmRef);
    expect(core.getBalance('e1', 'l1').balance).toBe(6); // applied once
  });

  it('rejects an insufficient debit by default (well-behaved HCM)', () => {
    expect(() =>
      core.applyDelta({ employeeId: 'e1', locationId: 'l1', amount: 99, type: 'DEBIT', idempotencyKey: 'k' }),
    ).toThrow(HcmRejection);
  });

  it('injects transient failures then recovers (C4)', () => {
    core.configureFaults({ failuresToInject: 2 });
    const cmd = { employeeId: 'e1', locationId: 'l1', amount: 1, type: 'DEBIT' as const, idempotencyKey: 'k' };
    expect(() => core.applyDelta(cmd)).toThrow(HcmUnavailable);
    expect(() => core.applyDelta(cmd)).toThrow(HcmUnavailable);
    const ack = core.applyDelta(cmd); // third succeeds
    expect(ack.applied).toBe(true);
  });

  it('rejects invalid dimensions when configured', () => {
    core.configureFaults({ invalidDimensions: ['e1|l1'] });
    expect(() => core.getBalance('e1', 'l1')).toThrow(HcmRejection);
  });

  describe('defensive: HCM that does NOT report errors (C5, G5)', () => {
    it('silentOverdraw accepts an over-draw without erroring, going negative', () => {
      core.configureFaults({ silentOverdraw: true });
      const ack = core.applyDelta({ employeeId: 'e1', locationId: 'l1', amount: 99, type: 'DEBIT', idempotencyKey: 'k' });
      expect(ack.applied).toBe(true);
      expect(ack.balance).toBe(10 - 99);
    });

    it('ghostSuccess returns success WITHOUT changing the balance', () => {
      core.configureFaults({ ghostSuccess: true });
      const ack = core.applyDelta({ employeeId: 'e1', locationId: 'l1', amount: 4, type: 'DEBIT', idempotencyKey: 'k' });
      expect(ack.applied).toBe(false);
      expect(core.getBalance('e1', 'l1').balance).toBe(10); // untouched
    });
  });

  it('adjust simulates an independent HCM change (anniversary bonus)', () => {
    const row = core.adjust('e1', 'l1', 5);
    expect(row.balance).toBe(15);
    expect(row.version).toBe(2);
  });

  it('dumpCorpus returns all balances for the batch endpoint', () => {
    core.seed('e2', 'l1', 3);
    expect(core.dumpCorpus()).toHaveLength(2);
  });

  describe('autoCreateUnknown = false (strict dimensions)', () => {
    beforeEach(() => core.configureFaults({ autoCreateUnknown: false }));

    it('getBalance rejects an unknown (emp,loc)', () => {
      expect(() => core.getBalance('ghost', 'l9')).toThrow(HcmRejection);
    });

    it('applyDelta rejects an unknown (emp,loc)', () => {
      expect(() =>
        core.applyDelta({ employeeId: 'ghost', locationId: 'l9', amount: 1, type: 'DEBIT', idempotencyKey: 'k' }),
      ).toThrow(HcmRejection);
    });

    it('still auto-creates via getBalance when enabled', () => {
      core.configureFaults({ autoCreateUnknown: true });
      expect(core.getBalance('new', 'l1').balance).toBe(0);
    });
  });

  it('adjust on an unknown dimension throws', () => {
    expect(() => core.adjust('ghost', 'l9', 5)).toThrow(HcmRejection);
  });

  it('a CREDIT increases the balance', () => {
    const ack = core.applyDelta({ employeeId: 'e1', locationId: 'l1', amount: 5, type: 'CREDIT', idempotencyKey: 'c' });
    expect(ack.balance).toBe(15);
  });
});
