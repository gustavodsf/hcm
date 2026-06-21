import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, TestContext } from '../utils/test-app';

/** Readiness reports 'degraded' when the database is unreachable (TRD §8.4). */
describe('health readiness when DB is down (e2e)', () => {
  let ctx: TestContext;

  afterEach(async () => {
    try {
      await ctx.close();
    } catch {
      /* datasource already destroyed by the test */
    }
  });

  it('returns degraded after the datasource is destroyed', async () => {
    ctx = await createTestApp();
    const ds = ctx.app.get(DataSource);
    await ds.destroy(); // simulate DB outage

    const res = await request(ctx.app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.db).toBe('down');
  });
});
