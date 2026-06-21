/**
 * Minimal circuit breaker (TRD §5.4) so a slow/dead HCM degrades gracefully
 * instead of stalling the outbox processor on every cycle.
 *
 * States: CLOSED (normal) → OPEN (fail fast) → HALF_OPEN (probe) → CLOSED.
 * Time is injected (`now()`) to keep it deterministic under test.
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number; // consecutive failures before opening
  cooldownMs: number; // how long to stay OPEN before probing
  now?: () => number; // injectable clock
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Current state, transitioning OPEN→HALF_OPEN if the cooldown has elapsed. */
  getState(): CircuitState {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.opts.cooldownMs) {
      this.state = 'HALF_OPEN';
    }
    return this.state;
  }

  /** True if a call should be allowed through right now. */
  canAttempt(): boolean {
    return this.getState() !== 'OPEN';
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.opts.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = this.now();
    }
  }
}
