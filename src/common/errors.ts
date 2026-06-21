import { ConflictException, UnprocessableEntityException } from '@nestjs/common';

/**
 * Domain error codes — stable, machine-readable identifiers returned in the
 * error envelope's `error` field so clients/tests can branch on cause.
 */
export enum DomainErrorCode {
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  ILLEGAL_TRANSITION = 'ILLEGAL_TRANSITION',
  INVALID_DIMENSIONS = 'INVALID_DIMENSIONS',
  REQUEST_NOT_FOUND = 'REQUEST_NOT_FOUND',
  BALANCE_NOT_FOUND = 'BALANCE_NOT_FOUND',
}

/** Raised when a request's days exceed derived available balance. → HTTP 409. */
export class InsufficientBalanceError extends ConflictException {
  constructor(public readonly requested: number, public readonly available: number) {
    super({
      error: DomainErrorCode.INSUFFICIENT_BALANCE,
      message: `Requested ${requested} day(s) exceeds available balance of ${available}.`,
      details: { requested, available },
    });
  }
}

/** Raised when a state-machine transition is not permitted. → HTTP 422. */
export class IllegalTransitionError extends UnprocessableEntityException {
  constructor(public readonly from: string, public readonly action: string) {
    super({
      error: DomainErrorCode.ILLEGAL_TRANSITION,
      message: `Action '${action}' is not allowed from state '${from}'.`,
      details: { from, action },
    });
  }
}

/** Raised when HCM rejects an (employeeId, locationId) combination. → HTTP 422. */
export class InvalidDimensionsError extends UnprocessableEntityException {
  constructor(employeeId: string, locationId: string) {
    super({
      error: DomainErrorCode.INVALID_DIMENSIONS,
      message: `HCM rejected dimensions employeeId=${employeeId}, locationId=${locationId}.`,
      details: { employeeId, locationId },
    });
  }
}
