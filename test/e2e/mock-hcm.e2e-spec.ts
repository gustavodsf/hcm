import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { HttpHcmClient } from '../../src/hcm/http-hcm.client';
import { HcmRejection, HcmUnavailable } from '../../src/hcm/hcm-core';
import { MockHcmModule } from '../../src/mock-hcm/mock-hcm.module';

/**
 * Boots the REAL standalone mock HCM server and drives it through the REAL
 * HttpHcmClient over HTTP (TRD §5.4/§10.3). Proves the deployable mock and the
 * transport/circuit-breaker mapping work end-to-end.
 */
describe('standalone mock HCM via HttpHcmClient (e2e)', () => {
  let app: INestApplication;
  let client: HttpHcmClient;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => app.close());

  beforeEach(async () => {
    // Fresh client per test so a tripped circuit breaker never leaks across tests.
    client = new HttpHcmClient({ baseUrl, failureThreshold: 3, cooldownMs: 50 });
    await fetch(`${baseUrl}/control/reset`, { method: 'POST' });
    await fetch(`${baseUrl}/control/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employeeId: 'e1', locationId: 'l1', balance: 10 }),
    });
  });

  const setFaults = (faults: Record<string, unknown>) =>
    fetch(`${baseUrl}/control/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(faults),
    });

  it('reads a seeded balance', async () => {
    const row = await client.getBalance('e1', 'l1');
    expect(row.balance).toBe(10);
  });

  it('applies a debit and replays idempotently', async () => {
    const cmd = { employeeId: 'e1', locationId: 'l1', amount: 3, type: 'DEBIT' as const, idempotencyKey: 'k1' };
    const a = await client.applyDelta(cmd);
    expect(a.balance).toBe(7);
    const b = await client.applyDelta(cmd);
    expect(b.replayed).toBe(true);
    expect((await client.getBalance('e1', 'l1')).balance).toBe(7);
  });

  it('maps an insufficient debit to HcmRejection (422)', async () => {
    await expect(
      client.applyDelta({ employeeId: 'e1', locationId: 'l1', amount: 99, type: 'DEBIT', idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(HcmRejection);
  });

  it('maps a transient 503 to HcmUnavailable and opens the circuit', async () => {
    await setFaults({ failuresToInject: 10 });
    // Three transient failures should trip the breaker (failureThreshold: 3).
    for (let i = 0; i < 3; i++) {
      await expect(
        client.applyDelta({ employeeId: 'e1', locationId: 'l1', amount: 1, type: 'DEBIT', idempotencyKey: `k${i}` }),
      ).rejects.toBeInstanceOf(HcmUnavailable);
    }
    // Next call fails fast due to the open circuit (no HTTP round-trip).
    await expect(client.getBalance('e1', 'l1')).rejects.toThrow(/circuit is open/);
  });

  it('serves the full corpus', async () => {
    const res = await fetch(`${baseUrl}/corpus`);
    const body = (await res.json()) as { balances: unknown[] };
    expect(body.balances.length).toBeGreaterThanOrEqual(1);
  });

  it('control/adjust simulates an independent HCM change (anniversary bonus)', async () => {
    await fetch(`${baseUrl}/control/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employeeId: 'e1', locationId: 'l1', delta: 5 }),
    });
    expect((await client.getBalance('e1', 'l1')).balance).toBe(15);
  });

  it('control/adjust on an unknown dimension returns 422', async () => {
    const res = await fetch(`${baseUrl}/control/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employeeId: 'nope', locationId: 'l9', delta: 1 }),
    });
    expect(res.status).toBe(422);
  });

  it('maps configured invalid dimensions to HcmRejection', async () => {
    await setFaults({ invalidDimensions: ['e1|l1'] });
    await expect(client.getBalance('e1', 'l1')).rejects.toBeInstanceOf(HcmRejection);
  });

  it('control/emit-batch pushes the corpus to a target URL', async () => {
    // Point at an endpoint on the same server that accepts a POST (control/faults).
    const res = await fetch(`${baseUrl}/control/emit-batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetUrl: `${baseUrl}/control/faults` }),
    });
    const body = (await res.json()) as { ok: boolean; status: number };
    expect(body.status).toBe(200);
  });

  it('control/emit-batch reports ok:false when the target rejects', async () => {
    const res = await fetch(`${baseUrl}/control/emit-batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetUrl: `${baseUrl}/corpus` }), // GET-only → 404
    });
    const body = (await res.json()) as { ok: boolean; status: number };
    expect(body.ok).toBe(false);
  });
});
