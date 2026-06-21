import { computeAvailable } from './balance-math';
import { ReconciliationEventType } from './enums';

/**
 * Pure reconciliation logic — TRD §7.2. No DB, no Nest.
 *
 * The crux (C7, no double-count): HCM's authoritative number already reflects
 * any debit HCM has applied. So when we accept a new snapshot we must STOP
 * subtracting locally exactly those committed entries HCM has absorbed
 * (identified by an acknowledged hcm_version <= the snapshot's version), while
 * STILL subtracting open reservations and not-yet-absorbed commits.
 */

export interface CommittedEntry {
  id: string;
  amount: number;
  /** The HCM version at which this debit was acknowledged, or null if unknown. */
  hcmVersion: number | null;
}

export interface ReconcileInput {
  /** Currently cached authoritative balance. */
  currentHcmBalance: number;
  /** Highest HCM version we have already reconciled (monotonic watermark). */
  lastReconciledVersion: number;
  /** Sum of ACTIVE reservations (soft holds). */
  reservedOpen: number;
  /** ACTIVE committed entries not yet marked reconciled. */
  committedEntries: CommittedEntry[];
  /** The authoritative value HCM just told us. */
  authoritativeBalance: number;
  authoritativeVersion: number;
}

export interface ReconcileResult {
  /** False when the incoming version is stale (<= watermark): a no-op (C8). */
  applied: boolean;
  reason?: 'stale';
  /** Committed entries HCM has absorbed; caller marks these RECONCILED. */
  matchedCommitIds: string[];
  newHcmBalance: number;
  newLastReconciledVersion: number;
  /** committedPending after dropping matched entries. */
  committedPendingAfter: number;
  previousAvailable: number;
  newAvailable: number;
  /** authoritativeBalance − previous cached balance (raw HCM movement). */
  delta: number;
  /** newAvailable − previousAvailable (what the employee actually sees change). */
  availableDelta: number;
  eventType: ReconciliationEventType;
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const committedPendingBefore = input.committedEntries.reduce((s, e) => s + e.amount, 0);
  const previousAvailable = computeAvailable({
    hcmBalance: input.currentHcmBalance,
    reservedOpen: input.reservedOpen,
    committedPending: committedPendingBefore,
  });

  // C8: never go backwards. Stale or duplicate snapshot → no-op (idempotent).
  if (input.authoritativeVersion <= input.lastReconciledVersion) {
    return {
      applied: false,
      reason: 'stale',
      matchedCommitIds: [],
      newHcmBalance: input.currentHcmBalance,
      newLastReconciledVersion: input.lastReconciledVersion,
      committedPendingAfter: committedPendingBefore,
      previousAvailable,
      newAvailable: previousAvailable,
      delta: 0,
      availableDelta: 0,
      eventType: ReconciliationEventType.RECONCILED,
    };
  }

  // C7: an acknowledged commit at version <= the snapshot is already baked into
  // the authoritative number → stop subtracting it locally.
  const matched = input.committedEntries.filter(
    (e) => e.hcmVersion !== null && e.hcmVersion <= input.authoritativeVersion,
  );
  const matchedIds = new Set(matched.map((e) => e.id));
  const committedPendingAfter = input.committedEntries
    .filter((e) => !matchedIds.has(e.id))
    .reduce((s, e) => s + e.amount, 0);

  const newAvailable = computeAvailable({
    hcmBalance: input.authoritativeBalance,
    reservedOpen: input.reservedOpen,
    committedPending: committedPendingAfter,
  });

  const delta = input.authoritativeBalance - input.currentHcmBalance;
  const availableDelta = newAvailable - previousAvailable;

  // Classify by what the EMPLOYEE sees (availableDelta), not the raw HCM
  // movement: HCM absorbing our own committed debit nets zero available change
  // and is a plain RECONCILED, while an anniversary bonus shows up as a real gain.
  let eventType: ReconciliationEventType;
  if (newAvailable < 0) {
    eventType = ReconciliationEventType.OVER_ALLOCATED; // C9
  } else if (availableDelta > 0) {
    eventType = ReconciliationEventType.BALANCE_INCREASED; // anniversary/refresh (C3)
  } else if (availableDelta < 0) {
    eventType = ReconciliationEventType.BALANCE_DECREASED;
  } else {
    eventType = ReconciliationEventType.RECONCILED;
  }

  return {
    applied: true,
    matchedCommitIds: [...matchedIds],
    newHcmBalance: input.authoritativeBalance,
    newLastReconciledVersion: input.authoritativeVersion,
    committedPendingAfter,
    previousAvailable,
    newAvailable,
    delta,
    availableDelta,
    eventType,
  };
}
