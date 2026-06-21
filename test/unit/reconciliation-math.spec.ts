import { ReconciliationEventType } from '../../src/common/enums';
import { reconcile } from '../../src/common/reconciliation-math';

const base = {
  currentHcmBalance: 10,
  lastReconciledVersion: 1,
  reservedOpen: 0,
  committedEntries: [],
  authoritativeBalance: 10,
  authoritativeVersion: 2,
};

describe('reconciliation-math (TRD §7.2)', () => {
  it('ignores stale/duplicate snapshots (C8)', () => {
    const r = reconcile({ ...base, authoritativeVersion: 1 });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('stale');
    expect(r.newHcmBalance).toBe(10);
  });

  it('is idempotent: replaying the same version is a no-op (C7)', () => {
    const first = reconcile({ ...base, authoritativeBalance: 8, authoritativeVersion: 3 });
    expect(first.applied).toBe(true);
    const replay = reconcile({
      ...base,
      currentHcmBalance: first.newHcmBalance,
      lastReconciledVersion: first.newLastReconciledVersion,
      authoritativeBalance: 8,
      authoritativeVersion: 3,
    });
    expect(replay.applied).toBe(false);
  });

  it('an anniversary bonus surfaces as BALANCE_INCREASED (C3)', () => {
    const r = reconcile({ ...base, authoritativeBalance: 15, authoritativeVersion: 3 });
    expect(r.eventType).toBe(ReconciliationEventType.BALANCE_INCREASED);
    expect(r.availableDelta).toBe(5);
    expect(r.newAvailable).toBe(15);
  });

  it('matches our committed debit and does NOT double-count it (C7)', () => {
    // We committed 4 at hcm version 2; HCM now reports 6 at version 3 (it applied our debit).
    const r = reconcile({
      currentHcmBalance: 10,
      lastReconciledVersion: 2,
      reservedOpen: 0,
      committedEntries: [{ id: 'c1', amount: 4, hcmVersion: 3 }],
      authoritativeBalance: 6,
      authoritativeVersion: 3,
    });
    expect(r.matchedCommitIds).toEqual(['c1']);
    expect(r.committedPendingAfter).toBe(0);
    // available was 10−4=6 before; now 6−0=6. No change → plain RECONCILED.
    expect(r.newAvailable).toBe(6);
    expect(r.availableDelta).toBe(0);
    expect(r.eventType).toBe(ReconciliationEventType.RECONCILED);
  });

  it('does NOT match a commit acknowledged at a HIGHER version than the snapshot', () => {
    const r = reconcile({
      currentHcmBalance: 10,
      lastReconciledVersion: 2,
      reservedOpen: 0,
      committedEntries: [{ id: 'c1', amount: 4, hcmVersion: 9 }],
      authoritativeBalance: 10,
      authoritativeVersion: 3,
    });
    expect(r.matchedCommitIds).toEqual([]);
    expect(r.committedPendingAfter).toBe(4); // still subtracted locally
    expect(r.newAvailable).toBe(6);
  });

  it('flags OVER_ALLOCATED when a downward correction drops below reservations (C9)', () => {
    const r = reconcile({
      currentHcmBalance: 10,
      lastReconciledVersion: 1,
      reservedOpen: 8, // pending requests holding 8
      committedEntries: [],
      authoritativeBalance: 5, // HR cut the balance
      authoritativeVersion: 2,
    });
    expect(r.newAvailable).toBe(-3);
    expect(r.eventType).toBe(ReconciliationEventType.OVER_ALLOCATED);
  });

  it('reports BALANCE_DECREASED for an unexplained downward move that stays non-negative', () => {
    const r = reconcile({ ...base, authoritativeBalance: 7, authoritativeVersion: 3 });
    expect(r.eventType).toBe(ReconciliationEventType.BALANCE_DECREASED);
    expect(r.availableDelta).toBe(-3);
  });
});
