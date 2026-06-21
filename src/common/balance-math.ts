/**
 * Pure balance arithmetic — no DB, no Nest. The heart of TRD §6.
 *
 * Isolated here so the most safety-critical logic (no-double-spend,
 * no-double-count) is exhaustively unit-testable in isolation.
 */

export interface BalanceComponents {
  /** Last authoritative value cached from HCM. */
  hcmBalance: number;
  /** Sum of ACTIVE RESERVE ledger entries (soft holds). */
  reservedOpen: number;
  /**
   * Sum of ACTIVE COMMIT ledger entries that HCM's current snapshot has NOT
   * yet absorbed. These must keep being subtracted so we don't appear to have
   * balance we've already spent (TRD §6.1, the double-count fix C7).
   */
  committedPending: number;
}

export interface BalanceView extends BalanceComponents {
  available: number;
}

/**
 * available = hcmBalance − reservedOpen − committedPending
 *
 * May be negative — that is a real, meaningful state (HCM corrected a balance
 * downward below what we already committed). Callers decide how to surface it;
 * we never clamp here, because clamping would hide an over-allocation (C9).
 */
export function computeAvailable(c: BalanceComponents): number {
  return c.hcmBalance - c.reservedOpen - c.committedPending;
}

export function toView(c: BalanceComponents): BalanceView {
  return { ...c, available: computeAvailable(c) };
}

/**
 * Can we reserve `days` against these components?
 * The single predicate that prevents over-spend (C2/C3).
 */
export function canReserve(c: BalanceComponents, days: number): boolean {
  return days > 0 && days <= computeAvailable(c);
}

/** True when committed allocations exceed what HCM now says exists (C9). */
export function isOverAllocated(c: BalanceComponents): boolean {
  return computeAvailable(c) < 0;
}
