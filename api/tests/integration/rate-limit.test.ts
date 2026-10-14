import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ generalRateLimitPerMinute: 3 });
});
afterAll(() => h.close());

describe('general rate limit (T-10)', () => {
  it('answers 429 once an address exceeds the per-minute ceiling, on any route', async () => {
    for (let i = 0; i < 3; i++) expect((await request(h.app).get('/api/v1/health')).status).toBe(200);
    const blocked = await request(h.app).get('/api/v1/health');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});
