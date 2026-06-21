import { CircuitBreaker } from '../../src/common/circuit-breaker';

describe('CircuitBreaker (TRD §5.4)', () => {
  let clock: number;
  const breaker = () =>
    new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => clock });

  beforeEach(() => {
    clock = 0;
  });

  it('starts CLOSED and allows attempts', () => {
    const cb = breaker();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.canAttempt()).toBe(true);
  });

  it('opens after the failure threshold and fails fast', () => {
    const cb = breaker();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('CLOSED');
    cb.recordFailure(); // third
    expect(cb.getState()).toBe('OPEN');
    expect(cb.canAttempt()).toBe(false);
  });

  it('moves to HALF_OPEN after cooldown, then CLOSED on success', () => {
    const cb = breaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');
    clock += 1000;
    expect(cb.getState()).toBe('HALF_OPEN');
    expect(cb.canAttempt()).toBe(true);
    cb.recordSuccess();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('a success resets the consecutive failure counter', () => {
    const cb = breaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('CLOSED'); // only 2 since reset
  });
});
