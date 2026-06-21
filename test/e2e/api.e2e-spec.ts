import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, TestContext } from '../utils/test-app';

/**
 * HTTP-level tests of the documented REST surface (TRD §8) including the error
 * envelope and idempotency header.
 */
describe('Time-Off API (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    http = request(app.getHttpServer());
    ctx.hcm.seed('e1', 'l1', 10);
  });
  afterEach(() => ctx.close());

  const body = (overrides = {}) => ({
    employeeId: 'e1',
    locationId: 'l1',
    startDate: '2026-07-01',
    endDate: '2026-07-02',
    days: 2,
    ...overrides,
  });

  it('GET /v1/balances returns the derived view', async () => {
    const res = await http.get('/v1/balances').query({ employeeId: 'e1', locationId: 'l1' }).expect(200);
    expect(res.body).toMatchObject({ hcmBalance: 10, available: 10 });
  });

  it('GET /v1/balances without params is a 400 with the error envelope', async () => {
    const res = await http.get('/v1/balances').query({ employeeId: 'e1' }).expect(400);
    expect(res.body).toMatchObject({ statusCode: 400 });
  });

  it('full lifecycle over HTTP: create+submit → approve → drain → COMMITTED', async () => {
    const created = await http.post('/v1/time-off-requests').send(body({ submit: true })).expect(201);
    expect(created.body.status).toBe('PENDING_APPROVAL');
    const id = created.body.id;

    await http.post(`/v1/time-off-requests/${id}/approve`).expect(200);
    await http.post('/v1/internal/outbox/drain').expect(200);

    const got = await http.get(`/v1/time-off-requests/${id}`).expect(200);
    expect(got.body.status).toBe('COMMITTED');

    const bal = await http.get('/v1/balances').query({ employeeId: 'e1', locationId: 'l1' }).expect(200);
    expect(bal.body.available).toBe(8);
  });

  it('over-requesting returns 409 INSUFFICIENT_BALANCE in the envelope', async () => {
    const res = await http.post('/v1/time-off-requests').send(body({ days: 99, submit: true })).expect(409);
    expect(res.body).toMatchObject({ statusCode: 409, error: 'INSUFFICIENT_BALANCE' });
    expect(res.body.details).toMatchObject({ requested: 99, available: 10 });
  });

  it('validation failure (negative days) returns 400', async () => {
    await http.post('/v1/time-off-requests').send(body({ days: -3 })).expect(400);
  });

  it('approving a fresh DRAFT is an illegal transition (422)', async () => {
    const created = await http.post('/v1/time-off-requests').send(body()).expect(201);
    const res = await http.post(`/v1/time-off-requests/${created.body.id}/approve`).expect(422);
    expect(res.body.error).toBe('ILLEGAL_TRANSITION');
  });

  it('Idempotency-Key dedupes create', async () => {
    const a = await http.post('/v1/time-off-requests').set('Idempotency-Key', 'abc').send(body()).expect(201);
    const b = await http.post('/v1/time-off-requests').set('Idempotency-Key', 'abc').send(body()).expect(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it('GET unknown request returns 404 REQUEST_NOT_FOUND', async () => {
    const res = await http.get('/v1/time-off-requests/does-not-exist').expect(404);
    expect(res.body.error).toBe('REQUEST_NOT_FOUND');
  });

  describe('sync endpoints', () => {
    it('realtime webhook updates the balance', async () => {
      await http.get('/v1/balances').query({ employeeId: 'e1', locationId: 'l1' }); // load v1
      const row = ctx.hcm.adjust('e1', 'l1', 5);
      await http
        .post('/v1/sync/hcm/balance')
        .send({ employeeId: 'e1', locationId: 'l1', balance: row.balance, version: row.version })
        .expect(200);
      const bal = await http.get('/v1/balances').query({ employeeId: 'e1', locationId: 'l1' }).expect(200);
      expect(bal.body.available).toBe(15);
    });

    it('batch ingest is accepted and reported', async () => {
      ctx.hcm.seed('e2', 'l1', 3);
      const res = await http.post('/v1/sync/hcm/batch').send({ balances: ctx.hcm.dumpCorpus() }).expect(200);
      expect(res.body.processed).toBeGreaterThanOrEqual(2);
    });

    it('events endpoint lists reconciliation events', async () => {
      await http.get('/v1/balances').query({ employeeId: 'e1', locationId: 'l1' });
      const row = ctx.hcm.adjust('e1', 'l1', 4);
      await http.post('/v1/sync/hcm/balance').send({ employeeId: 'e1', locationId: 'l1', balance: row.balance, version: row.version });
      const res = await http.get('/v1/sync/events').query({ type: 'BALANCE_INCREASED' }).expect(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('lifecycle verbs over HTTP', () => {
    const createDraft = () => http.post('/v1/time-off-requests').send(body()).expect(201);

    it('POST /:id/submit then /:id/reject', async () => {
      const { body: draft } = await createDraft();
      const submitted = await http.post(`/v1/time-off-requests/${draft.id}/submit`).expect(200);
      expect(submitted.body.status).toBe('PENDING_APPROVAL');
      const rejected = await http.post(`/v1/time-off-requests/${draft.id}/reject`).expect(200);
      expect(rejected.body.status).toBe('REJECTED');
    });

    it('POST /:id/cancel releases a pending request', async () => {
      const { body: draft } = await createDraft();
      await http.post(`/v1/time-off-requests/${draft.id}/submit`).expect(200);
      const cancelled = await http.post(`/v1/time-off-requests/${draft.id}/cancel`).expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
    });

    it('GET /v1/time-off-requests filters by employee and status', async () => {
      const { body: draft } = await createDraft();
      await http.post(`/v1/time-off-requests/${draft.id}/submit`).expect(200);
      const res = await http
        .get('/v1/time-off-requests')
        .query({ employeeId: 'e1', status: 'PENDING_APPROVAL' })
        .expect(200);
      expect(res.body).toHaveLength(1);
    });

    it('GET /v1/balances/:employeeId returns all locations', async () => {
      ctx.hcm.seed('e1', 'l2', 4);
      await http.get('/v1/balances').query({ employeeId: 'e1', locationId: 'l1' });
      await http.get('/v1/balances').query({ employeeId: 'e1', locationId: 'l2' });
      const res = await http.get('/v1/balances/e1').expect(200);
      expect(res.body.employeeId).toBe('e1');
      expect(res.body.balances.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('POST /v1/sync/reconcile re-pulls balances', async () => {
    await http.get('/v1/balances').query({ employeeId: 'e1', locationId: 'l1' });
    ctx.hcm.adjust('e1', 'l1', 6);
    const res = await http.post('/v1/sync/reconcile').expect(200);
    expect(res.body.processed).toBeGreaterThanOrEqual(1);
  });

  it('GET /health and /health/ready report ok', async () => {
    await http.get('/health').expect(200).expect({ status: 'ok' });
    const ready = await http.get('/health/ready').expect(200);
    expect(ready.body.status).toBe('ok');
  });
});
