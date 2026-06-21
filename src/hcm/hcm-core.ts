/**
 * In-memory HCM simulation engine — the single source of behavior shared by
 * BOTH the standalone mock HCM server and the in-process test double
 * (TRD §10.3). Deterministic and fault-injectable.
 *
 * It models the realtime API (get balance / apply delta) with:
 *  - idempotent application keyed by idempotencyKey (C6),
 *  - monotonic version stamps per (employeeId, locationId) (C8),
 *  - fault injection: transient failures, latency, invalid dimensions,
 *    and the critical "HCM doesn't always return errors" behaviors (C5).
 */

export interface HcmBalanceRow {
  employeeId: string;
  locationId: string;
  balance: number;
  version: number;
  asOf: string; // ISO timestamp
}

export interface ApplyDeltaCommand {
  employeeId: string;
  locationId: string;
  amount: number; // positive magnitude
  type: 'DEBIT' | 'CREDIT';
  idempotencyKey: string;
}

export interface ApplyDeltaAck {
  hcmRef: string;
  balance: number;
  version: number;
  /** Whether HCM actually changed the balance (false under ghost-success). */
  applied: boolean;
  /** True when this was a replay of a prior idempotency key. */
  replayed: boolean;
}

export class HcmRejection extends Error {
  constructor(
    public readonly code: 'INSUFFICIENT_BALANCE' | 'INVALID_DIMENSIONS',
    message: string,
  ) {
    super(message);
    this.name = 'HcmRejection';
  }
}

export class HcmUnavailable extends Error {
  constructor(message = 'HCM temporarily unavailable') {
    super(message);
    this.name = 'HcmUnavailable';
  }
}

export interface HcmFaultConfig {
  /** Emit this many transient failures before the next success (then auto-decrements). */
  failuresToInject: number;
  /** Simulated processing latency (ms). The async caller awaits it. */
  latencyMs: number;
  /** (employeeId|locationId) keys HCM should reject as invalid dimensions. */
  invalidDimensions: string[];
  /** Create unknown (emp,loc) on first reference instead of rejecting. */
  autoCreateUnknown: boolean;
  /** C5: silently accept debits beyond balance (no error), driving balance negative. */
  silentOverdraw: boolean;
  /** C5: return success WITHOUT changing the balance (HCM ignored our write). */
  ghostSuccess: boolean;
}

const DEFAULT_FAULTS: HcmFaultConfig = {
  failuresToInject: 0,
  latencyMs: 0,
  invalidDimensions: [],
  autoCreateUnknown: true,
  silentOverdraw: false,
  ghostSuccess: false,
};

const key = (employeeId: string, locationId: string) => `${employeeId}|${locationId}`;

export class HcmCore {
  private readonly balances = new Map<string, HcmBalanceRow>();
  /** idempotencyKey -> prior ack (dedupe, C6). */
  private readonly applied = new Map<string, ApplyDeltaAck>();
  private faults: HcmFaultConfig = { ...DEFAULT_FAULTS };
  private refSeq = 0;

  /** Injectable clock + ref generator keep tests deterministic. */
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly genRef: () => string = () => `hcm-ref-${++this.refSeq}`,
  ) {}

  // ---- Test/ops control surface -------------------------------------------

  configureFaults(partial: Partial<HcmFaultConfig>): void {
    this.faults = { ...this.faults, ...partial };
  }

  reset(): void {
    this.balances.clear();
    this.applied.clear();
    this.faults = { ...DEFAULT_FAULTS };
    this.refSeq = 0;
  }

  /** Seed/overwrite a balance (e.g. initial provisioning). Bumps version. */
  seed(employeeId: string, locationId: string, balance: number): HcmBalanceRow {
    const k = key(employeeId, locationId);
    const prev = this.balances.get(k);
    const row: HcmBalanceRow = {
      employeeId,
      locationId,
      balance,
      version: (prev?.version ?? 0) + 1,
      asOf: this.now().toISOString(),
    };
    this.balances.set(k, row);
    return row;
  }

  /** Independent HCM-side change (anniversary bonus, HR edit, annual refresh). */
  adjust(employeeId: string, locationId: string, delta: number): HcmBalanceRow {
    const row = this.requireRow(employeeId, locationId);
    row.balance += delta;
    row.version += 1;
    row.asOf = this.now().toISOString();
    return { ...row };
  }

  // ---- Realtime API --------------------------------------------------------

  getBalance(employeeId: string, locationId: string): HcmBalanceRow {
    const k = key(employeeId, locationId);
    if (this.faults.invalidDimensions.includes(k)) {
      throw new HcmRejection('INVALID_DIMENSIONS', `Unknown dimensions ${k}`);
    }
    const row = this.balances.get(k);
    if (!row) {
      if (this.faults.autoCreateUnknown) {
        return this.seed(employeeId, locationId, 0);
      }
      throw new HcmRejection('INVALID_DIMENSIONS', `Unknown dimensions ${k}`);
    }
    return { ...row };
  }

  /** Apply a debit/credit. Throws HcmUnavailable (retryable) or HcmRejection. */
  applyDelta(cmd: ApplyDeltaCommand): ApplyDeltaAck {
    // Idempotent replay (C6): return the original outcome, no double-apply.
    const prior = this.applied.get(cmd.idempotencyKey);
    if (prior) {
      return { ...prior, replayed: true };
    }

    // Transient failure injection (C4): fail fast, do not consume idempotency.
    if (this.faults.failuresToInject > 0) {
      this.faults.failuresToInject -= 1;
      throw new HcmUnavailable();
    }

    const k = key(cmd.employeeId, cmd.locationId);
    if (this.faults.invalidDimensions.includes(k)) {
      throw new HcmRejection('INVALID_DIMENSIONS', `Unknown dimensions ${k}`);
    }

    let row = this.balances.get(k);
    if (!row) {
      if (!this.faults.autoCreateUnknown) {
        throw new HcmRejection('INVALID_DIMENSIONS', `Unknown dimensions ${k}`);
      }
      row = this.seed(cmd.employeeId, cmd.locationId, 0);
    }

    const signed = cmd.type === 'DEBIT' ? -cmd.amount : cmd.amount;
    const wouldGoNegative = cmd.type === 'DEBIT' && row.balance + signed < 0;

    // C5: HCM ghost-success — claim success but DON'T mutate the balance.
    if (this.faults.ghostSuccess) {
      const ack: ApplyDeltaAck = {
        hcmRef: this.genRef(),
        balance: row.balance,
        version: row.version,
        applied: false,
        replayed: false,
      };
      this.applied.set(cmd.idempotencyKey, ack);
      return ack;
    }

    if (wouldGoNegative && !this.faults.silentOverdraw) {
      // Normal, well-behaved HCM: authoritative rejection.
      throw new HcmRejection(
        'INSUFFICIENT_BALANCE',
        `Insufficient balance for ${k}: have ${row.balance}, need ${cmd.amount}`,
      );
    }

    // Apply (silentOverdraw lets balance go negative WITHOUT erroring — C5).
    row.balance += signed;
    row.version += 1;
    row.asOf = this.now().toISOString();
    const ack: ApplyDeltaAck = {
      hcmRef: this.genRef(),
      balance: row.balance,
      version: row.version,
      applied: true,
      replayed: false,
    };
    this.applied.set(cmd.idempotencyKey, ack);
    return { ...ack };
  }

  /** Full corpus emit for the batch endpoint (TRD §7.2). */
  dumpCorpus(): HcmBalanceRow[] {
    return [...this.balances.values()].map((r) => ({ ...r }));
  }

  private requireRow(employeeId: string, locationId: string): HcmBalanceRow {
    const row = this.balances.get(key(employeeId, locationId));
    if (!row) {
      throw new HcmRejection('INVALID_DIMENSIONS', `Unknown dimensions ${employeeId}|${locationId}`);
    }
    return row;
  }
}
