import { ApplyDeltaAck, ApplyDeltaCommand, HcmBalanceRow } from './hcm-core';

/** DI token for the HCM client implementation. */
export const HCM_CLIENT = Symbol('HCM_CLIENT');

/**
 * Abstraction over the HCM realtime API (TRD §5.4). Implemented by an HTTP
 * client (real / standalone mock) and an in-process double (fast tests).
 *
 * Contract:
 *  - getBalance / applyDelta reject with `HcmRejection` for AUTHORITATIVE
 *    refusals (insufficient / invalid dimensions) — do not retry these.
 *  - They reject with `HcmUnavailable` for TRANSIENT failures — safe to retry
 *    (idempotency makes retry safe).
 */
export interface IHcmClient {
  getBalance(employeeId: string, locationId: string): Promise<HcmBalanceRow>;
  applyDelta(cmd: ApplyDeltaCommand): Promise<ApplyDeltaAck>;
}
