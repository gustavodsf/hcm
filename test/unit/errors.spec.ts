import {
  DomainErrorCode,
  IllegalTransitionError,
  InsufficientBalanceError,
  InvalidDimensionsError,
} from '../../src/common/errors';

describe('domain errors', () => {
  it('InsufficientBalanceError carries code + details and 409', () => {
    const e = new InsufficientBalanceError(5, 2);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({
      error: DomainErrorCode.INSUFFICIENT_BALANCE,
      details: { requested: 5, available: 2 },
    });
  });

  it('IllegalTransitionError is 422 and names the action', () => {
    const e = new IllegalTransitionError('CANCELLED', 'APPROVE');
    expect(e.getStatus()).toBe(422);
    expect(e.getResponse()).toMatchObject({ error: DomainErrorCode.ILLEGAL_TRANSITION });
  });

  it('InvalidDimensionsError is 422 with the dimensions', () => {
    const e = new InvalidDimensionsError('e1', 'l9');
    expect(e.getStatus()).toBe(422);
    expect(e.getResponse()).toMatchObject({
      error: DomainErrorCode.INVALID_DIMENSIONS,
      details: { employeeId: 'e1', locationId: 'l9' },
    });
  });
});
