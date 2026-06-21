import { Injectable, Logger } from '@nestjs/common';
import { CircuitBreaker } from '../common/circuit-breaker';
import { ApplyDeltaAck, ApplyDeltaCommand, HcmBalanceRow, HcmRejection, HcmUnavailable } from './hcm-core';
import { IHcmClient } from './hcm-client.interface';

export interface HttpHcmClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  failureThreshold?: number;
  cooldownMs?: number;
}

/**
 * Real HTTP client for HCM's realtime API (TRD §5.4). Talks to a real HCM or
 * the standalone mock server. Adds a timeout and a circuit breaker so a
 * slow/dead HCM fails fast (as HcmUnavailable) instead of stalling the outbox.
 *
 * Maps transport/5xx → HcmUnavailable (retryable); 4xx with a domain code →
 * HcmRejection (authoritative, do not retry).
 */
@Injectable()
export class HttpHcmClient implements IHcmClient {
  private readonly logger = new Logger(HttpHcmClient.name);
  private readonly breaker: CircuitBreaker;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpHcmClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.breaker = new CircuitBreaker({
      failureThreshold: opts.failureThreshold ?? 5,
      cooldownMs: opts.cooldownMs ?? 10000,
    });
  }

  async getBalance(employeeId: string, locationId: string): Promise<HcmBalanceRow> {
    return this.guarded(async () => {
      const res = await this.fetch(
        `/balances/${encodeURIComponent(employeeId)}/${encodeURIComponent(locationId)}`,
      );
      return (await this.parse(res)) as HcmBalanceRow;
    });
  }

  async applyDelta(cmd: ApplyDeltaCommand): Promise<ApplyDeltaAck> {
    return this.guarded(async () => {
      const res = await this.fetch('/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cmd),
      });
      return (await this.parse(res)) as ApplyDeltaAck;
    });
  }

  /** Circuit-breaker wrapper: short-circuit when OPEN, record outcomes. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.breaker.canAttempt()) {
      throw new HcmUnavailable('HCM circuit is open');
    }
    try {
      const out = await fn();
      this.breaker.recordSuccess();
      return out;
    } catch (err) {
      // Authoritative rejections are not "failures" of the dependency.
      if (err instanceof HcmRejection) throw err;
      this.breaker.recordFailure();
      throw err instanceof HcmUnavailable ? err : new HcmUnavailable(String(err));
    }
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.opts.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (err) {
      throw new HcmUnavailable(`HCM transport error: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse(res: Response): Promise<unknown> {
    if (res.ok) return res.json();
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON body */
    }
    if (res.status >= 500 || res.status === 429) {
      throw new HcmUnavailable(`HCM ${res.status}: ${body.message ?? 'server error'}`);
    }
    // 4xx domain rejection.
    const code = body.code === 'INVALID_DIMENSIONS' ? 'INVALID_DIMENSIONS' : 'INSUFFICIENT_BALANCE';
    throw new HcmRejection(code, body.message ?? `HCM rejected with ${res.status}`);
  }
}
