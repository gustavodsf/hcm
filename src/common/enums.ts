/**
 * Domain enums shared across modules.
 *
 * These are intentionally plain string enums (not TS numeric enums) so they
 * survive serialization to/from SQLite and JSON without surprises.
 */

/** Lifecycle states of a time-off request. See TRD §3.3. */
export enum RequestStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED', // approved locally; HCM debit enqueued, not yet acked
  COMMITTED = 'COMMITTED', // HCM acknowledged the debit
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  CANCELLATION_PENDING = 'CANCELLATION_PENDING', // cancel after commit; credit reversal enqueued
  FAILED = 'FAILED', // HCM authoritatively rejected or retries exhausted
}

/** Phase of a balance ledger entry. See TRD §3.2 / §6. */
export enum LedgerPhase {
  RESERVE = 'RESERVE', // soft hold, counts against available
  COMMIT = 'COMMIT', // debit acknowledged by HCM, pending reconciliation
  RELEASE = 'RELEASE', // reservation released back (reject/cancel/fail)
  HCM_ADJUSTMENT = 'HCM_ADJUSTMENT', // bookkeeping note for an authoritative HCM change
}

/** State of a ledger entry within its phase. */
export enum LedgerState {
  ACTIVE = 'ACTIVE', // currently affects available
  RELEASED = 'RELEASED', // no longer affects available (reservation given back)
  RECONCILED = 'RECONCILED', // HCM snapshot has absorbed this; drops out of committedPending
}

/** Outbox message types (mutations we propagate to HCM). */
export enum OutboxType {
  DEBIT = 'DEBIT', // spend balance in HCM (on approve)
  CREDIT = 'CREDIT', // refund balance in HCM (on cancel-after-commit)
}

/** Outbox message delivery status. See TRD §5.2. */
export enum OutboxStatus {
  PENDING = 'PENDING',
  INFLIGHT = 'INFLIGHT',
  DONE = 'DONE',
  FAILED = 'FAILED', // transient failure, will retry
  DEAD = 'DEAD', // exhausted retries; needs human attention
}

/** Reconciliation / drift event types surfaced for ops & audit. See TRD §7. */
export enum ReconciliationEventType {
  RECONCILED = 'RECONCILED',
  BALANCE_INCREASED = 'BALANCE_INCREASED', // e.g. anniversary bonus / annual refresh
  BALANCE_DECREASED = 'BALANCE_DECREASED',
  OVER_ALLOCATED = 'OVER_ALLOCATED', // HCM dropped below what we already committed
  DRIFT_DETECTED = 'DRIFT_DETECTED', // HCM disagrees with our model (e.g. silent accept)
}
