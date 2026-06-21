import { HcmCore } from '../../src/hcm/hcm-core';
import { InProcessHcmClient } from '../../src/hcm/in-process-hcm.client';

describe('InProcessHcmClient', () => {
  it('delegates getBalance/applyDelta to the wrapped core', async () => {
    const core = new HcmCore();
    core.seed('e1', 'l1', 10);
    const client = new InProcessHcmClient(core);

    expect((await client.getBalance('e1', 'l1')).balance).toBe(10);
    const ack = await client.applyDelta({
      employeeId: 'e1',
      locationId: 'l1',
      amount: 4,
      type: 'DEBIT',
      idempotencyKey: 'k',
    });
    expect(ack.balance).toBe(6);
    expect(client.hcm).toBe(core); // exposes core for fault injection
  });
});
