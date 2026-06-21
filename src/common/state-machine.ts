import { RequestStatus } from './enums';

/**
 * Actions that drive a time-off request through its lifecycle.
 * Mirrors the controller verbs and the TRD §3.3 diagram.
 */
export enum RequestAction {
  SUBMIT = 'SUBMIT',
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  CANCEL = 'CANCEL',
  HCM_COMMITTED = 'HCM_COMMITTED', // outbox: HCM acknowledged the debit
  HCM_REJECTED = 'HCM_REJECTED', // outbox: HCM authoritatively refused / retries exhausted
  HCM_CREDIT_DONE = 'HCM_CREDIT_DONE', // outbox: reversal credit acknowledged
}

/**
 * Pure transition table. The single source of truth for what is allowed.
 *
 * Keeping this as data (not scattered `if` statements) makes it exhaustively
 * unit-testable: every (state, action) pair has a defined answer.
 */
const TRANSITIONS: Readonly<Record<RequestStatus, Partial<Record<RequestAction, RequestStatus>>>> = {
  [RequestStatus.DRAFT]: {
    [RequestAction.SUBMIT]: RequestStatus.PENDING_APPROVAL,
    [RequestAction.CANCEL]: RequestStatus.CANCELLED,
  },
  [RequestStatus.PENDING_APPROVAL]: {
    [RequestAction.APPROVE]: RequestStatus.APPROVED,
    [RequestAction.REJECT]: RequestStatus.REJECTED,
    [RequestAction.CANCEL]: RequestStatus.CANCELLED,
  },
  [RequestStatus.APPROVED]: {
    // Commit/reject are driven by the outbox once HCM responds.
    [RequestAction.HCM_COMMITTED]: RequestStatus.COMMITTED,
    [RequestAction.HCM_REJECTED]: RequestStatus.FAILED,
    // A cancel while still APPROVED (debit not yet acked) is treated like a
    // pre-commit cancel: it releases the hold. The outbox debit, if it later
    // lands, is reconciled away (idempotent) or compensated.
    [RequestAction.CANCEL]: RequestStatus.CANCELLED,
  },
  [RequestStatus.COMMITTED]: {
    // Cancelling committed time off requires a compensating credit to HCM.
    [RequestAction.CANCEL]: RequestStatus.CANCELLATION_PENDING,
  },
  [RequestStatus.CANCELLATION_PENDING]: {
    [RequestAction.HCM_CREDIT_DONE]: RequestStatus.CANCELLED,
  },
  // Terminal states: no outgoing transitions.
  [RequestStatus.REJECTED]: {},
  [RequestStatus.CANCELLED]: {},
  [RequestStatus.FAILED]: {},
};

/** Returns true if `action` is legal from `from`. */
export function canTransition(from: RequestStatus, action: RequestAction): boolean {
  return TRANSITIONS[from]?.[action] !== undefined;
}

/** Returns the next state, or null if the transition is illegal. */
export function nextState(from: RequestStatus, action: RequestAction): RequestStatus | null {
  return TRANSITIONS[from]?.[action] ?? null;
}

/** Terminal states hold no active reservation and accept no actions. */
export function isTerminal(state: RequestStatus): boolean {
  return Object.keys(TRANSITIONS[state]).length === 0;
}

export { TRANSITIONS };
