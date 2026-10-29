import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildContainer } from '../../src/container.js';
import { createPool } from '../../src/db/pool.js';
import { createApp } from '../../src/http/app.js';
import { logger } from '../../src/infra/logger.js';
import { createHarness, TEST_DB, type Harness } from './harness.js';

/**
 * Task 2 feedback: show failure states such as "database connection lost" and "storage full", and
 * the recovery transitions. These tests put the real app in each state.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

function appOn(pool: pg.Pool) {
  const config = loadConfig({ databaseUrl: TEST_DB, pbkdf2Iterations: 1000, appBaseUrl: 'http://localhost:5173' });
  const { deps, services } = buildContainer(config, pool, logger);
  const app = createApp({ config, services, tokens: deps.tokens, pool, log: logger });
  const token = deps.tokens.issueAccessToken({ id: h.users.coordA, role: 'SiteCoordinator', name: 'Coordinator A', siteId: h.sites.A, donorId: null });
  return { app, auth: { Authorization: `Bearer ${token}` } };
}

describe('database unreachable', () => {
  const pool = createPool('postgresql://nobody:nothing@127.0.0.1:1/none', false);
  pool.on('error', () => undefined);
  let app: ReturnType<typeof appOn>['app'];
  let auth: Record<string, string>;
  beforeAll(() => {
    ({ app, auth } = appOn(pool));
  });
  afterAll(() => pool.end());

  it('answers 503 with Retry-After and a message that says nothing was saved, never a 500', async () => {
    const res = await request(app).get('/api/v1/households').set(auth);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body.error).toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect(res.body.error.message).toMatch(/nothing was saved/);
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'coorda@t.test', password: 'x' });
    expect(login.status).toBe(503);
  });

  it('reports "down" on the health check, which is what the smoke test and App Service watch', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'down', database: 'unreachable' });
  });
});

describe('storage full (Azure puts the server into read-only mode)', () => {
  const pool = new pg.Pool({ connectionString: TEST_DB, options: '-c default_transaction_read_only=on' });
  let app: ReturnType<typeof appOn>['app'];
  let auth: Record<string, string>;
  beforeAll(() => {
    ({ app, auth } = appOn(pool));
  });
  afterAll(() => pool.end());

  it('keeps reading but refuses writes with STORAGE_FULL', async () => {
    expect((await request(app).get('/api/v1/households').set(auth)).status).toBe(200);
    const res = await request(app).post('/api/v1/households').set(auth).send({
      headOfHousehold: 'Read Only', idNumber: '8001015009087', addressLine: '1 Road', suburb: 'Diepsloot', homeSiteId: h.sites.A,
      members: [{ firstName: 'Read', ageBand: '18-59', dependantType: 'Self' }],
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_FULL');
    expect(res.headers['retry-after']).toBe('300');
  });

  it('shows "degraded / read-only" on the health check', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'degraded', database: 'read-only' });
  });
});

describe('connection lost and recovered (database restart or failover)', () => {
  it('replaces broken connections by itself: no app restart is needed', async () => {
    const pool = new pg.Pool({ connectionString: TEST_DB, application_name: 'sizani-failover-test' });
    const errors: Error[] = [];
    pool.on('error', (e) => errors.push(e)); // what server.ts does: log, do not crash
    const { app, auth } = appOn(pool);

    expect((await request(app).get('/api/v1/households').set(auth)).status).toBe(200);
    // Kill every connection the app holds, as a server restart would.
    await h.pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'sizani-failover-test'`);
    await new Promise((r) => setTimeout(r, 100));

    const after = await request(app).get('/api/v1/households').set(auth);
    expect(after.status).toBe(200);
    expect(errors.length).toBeGreaterThanOrEqual(1); // the dropped idle connection was noticed and discarded
    expect((await request(app).get('/api/v1/health')).body.status).toBe('ok');
    await pool.end();
  });
});
