import { Injectable } from '@nestjs/common';
import { ApplyDeltaAck, ApplyDeltaCommand, HcmBalanceRow, HcmCore } from './hcm-core';
import { IHcmClient } from './hcm-client.interface';

/**
 * In-process HCM client (TRD §5.4 / §10.3). Wraps an HcmCore directly so the
 * test suite exercises the exact same simulation behavior as the standalone
 * mock server, but with zero network and full determinism.
 */
@Injectable()
export class InProcessHcmClient implements IHcmClient {
  constructor(private readonly core: HcmCore) {}

  async getBalance(employeeId: string, locationId: string): Promise<HcmBalanceRow> {
    return this.core.getBalance(employeeId, locationId);
  }

  async applyDelta(cmd: ApplyDeltaCommand): Promise<ApplyDeltaAck> {
    return this.core.applyDelta(cmd);
  }

  /** Expose the underlying core so tests/ops can inject faults and adjust HCM. */
  get hcm(): HcmCore {
    return this.core;
  }
}
