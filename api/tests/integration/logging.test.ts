import { Writable } from 'node:stream';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildContainer } from '../../src/container.js';
import { createApp, logRequest } from '../../src/http/app.js';
import { createHarness, TEST_DB, type Harness } from './harness.js';

/**
 * NFR-14: no credential or personal identifier appears in a log. Found while checking the NFRs for
 * the final report: request logs used to include the full URL, so a household search for a name, or
 * the token in an activation or reset link, was written to the log.
 */
let h: Harness;
const lines: string[] = [];
let app: ReturnType<typeof createApp>;
let auth: Record<string, string>;

beforeAll(async () => {
  h = await createHarness();
  const sink = new Writable({
    write(chunk, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const log = pino({ level: 'info' }, sink);
  const config = loadConfig({ databaseUrl: TEST_DB, pbkdf2Iterations: 1000, appBaseUrl: 'http://localhost:5173' });
  const { deps, services } = buildContainer(config, h.pool, log);
  app = createApp({ config, services, tokens: deps.tokens, pool: h.pool, log });
  const token = deps.tokens.issueAccessToken({ id: h.users.coordA, role: 'SiteCoordinator', name: 'Coordinator A', siteId: h.sites.A, donorId: null });
  auth = { Authorization: `Bearer ${token}` };
});
afterAll(() => h.close());

describe('request logs (NFR-14)', () => {
  it('keep the path but drop search terms, tokens and the referring page', async () => {
    await request(app).get('/api/v1/households?q=Nomvula%20Dlamini').set(auth).set('Referer', 'http://localhost:5173/reset-password?token=secret-reset-token');
    await request(app).get('/reset-password?token=secret-activation-token&activate=1');
    const logged = lines.join('\n');
    expect(logged).toContain('/api/v1/households');
    expect(logged).not.toMatch(/Nomvula|Dlamini/);
    expect(logged).not.toMatch(/secret-(reset|activation)-token/);
    expect(logged).not.toMatch(/Bearer|authorization/i);
  });

  it('serialises a request to method, path, address, referring path and browser only', () => {
    expect(
      logRequest({
        id: 1,
        method: 'GET',
        url: '/api/v1/events/5b0e7a52-35d6-4c43-9d5a-0f6f8a3f2b11/collections?page=2',
        remoteAddress: '10.0.0.1',
        headers: { referer: 'https://x.test/households?q=Nomvula', 'user-agent': 'UA', cookie: 'refresh=abc' },
      }),
    ).toEqual({ id: 1, method: 'GET', url: '/api/v1/events/5b0e7a52-35d6-4c43-9d5a-0f6f8a3f2b11/collections', remoteAddress: '10.0.0.1', referer: 'https://x.test/households', userAgent: 'UA' });
  });
});
