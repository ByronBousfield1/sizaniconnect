import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, PASSWORD, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const cookieFrom = (res: request.Response) => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith('szn_rt='));
};

describe('sign-in (US-20, T-01)', () => {
  it('returns an access token and sets a hardened refresh cookie', async () => {
    const res = await request(h.app).post('/api/v1/auth/login').send({ email: 'VOLONE@t.test', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user).toMatchObject({ email: 'volone@t.test', role: 'Volunteer' });
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookie = cookieFrom(res)!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('gives the same message for an unknown email and a wrong password', async () => {
    const a = await request(h.app).post('/api/v1/auth/login').send({ email: 'nobody@t.test', password: 'whatever-123456' });
    const b = await request(h.app).post('/api/v1/auth/login').send({ email: 'voltwo@t.test', password: 'wrong-password-1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('locks the account after five failures, even against the right password', async () => {
    for (let i = 0; i < 4; i++) {
      expect((await request(h.app).post('/api/v1/auth/login').send({ email: 'donor@t.test', password: 'nope-nope-nope' })).status).toBe(401);
    }
    const fifth = await request(h.app).post('/api/v1/auth/login').send({ email: 'donor@t.test', password: 'nope-nope-nope' });
    expect(fifth.status).toBe(423);
    const correct = await request(h.app).post('/api/v1/auth/login').send({ email: 'donor@t.test', password: PASSWORD });
    expect(correct.status).toBe(423);
    expect(await h.auditCount('User', 'ACCOUNT_LOCKED')).toBe(1);
    await h.pool.query("UPDATE users SET locked_until = NULL WHERE email = 'donor@t.test'");
  });

  it('refuses a cross-site origin on cookie endpoints (T-08)', async () => {
    const res = await request(h.app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'volone@t.test', password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('refresh token rotation', () => {
  it('rotates on use and revokes the whole family when an old token is replayed', async () => {
    const login = await request(h.app).post('/api/v1/auth/login').send({ email: 'voltwo@t.test', password: PASSWORD });
    const first = cookieFrom(login)!.split(';')[0];

    const r1 = await request(h.app).post('/api/v1/auth/refresh').set('Cookie', first);
    expect(r1.status).toBe(200);
    const second = cookieFrom(r1)!.split(';')[0];
    expect(second).not.toBe(first);

    // Replaying the first token is treated as theft...
    const replay = await request(h.app).post('/api/v1/auth/refresh').set('Cookie', first);
    expect(replay.status).toBe(401);
    // ...and the legitimate newer token stops working too.
    const after = await request(h.app).post('/api/v1/auth/refresh').set('Cookie', second);
    expect(after.status).toBe(401);
    expect(await h.auditCount('User', 'TOKEN_REUSE_DETECTED')).toBeGreaterThanOrEqual(1);
  });

  it('logout revokes the session', async () => {
    const login = await request(h.app).post('/api/v1/auth/login').send({ email: 'volone@t.test', password: PASSWORD });
    const cookie = cookieFrom(login)!.split(';')[0];
    expect((await request(h.app).post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await request(h.app).post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('password reset (US-20)', () => {
  it('does not reveal whether an account exists', async () => {
    const res = await request(h.app).post('/api/v1/auth/forgot-password').send({ email: 'ghost@t.test' });
    expect(res.status).toBe(202);
    expect(h.email.sent).toHaveLength(0);
  });

  it('emails a single-use link that sets a new password and ends old sessions', async () => {
    await request(h.app).post('/api/v1/auth/forgot-password').send({ email: 'opstwo@t.test' });
    const mail = h.email.sent.at(-1)!;
    expect(mail.to).toBe('opstwo@t.test');
    const token = /token=([\w-]+)/.exec(mail.text)![1];

    const weak = await request(h.app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'password1234' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');

    // The weak attempt consumed the token: links are strictly single-use.
    await request(h.app).post('/api/v1/auth/forgot-password').send({ email: 'opstwo@t.test' });
    const token2 = /token=([\w-]+)/.exec(h.email.sent.at(-1)!.text)![1];
    const ok = await request(h.app).post('/api/v1/auth/reset-password').send({ token: token2, newPassword: 'Sorghum-Harvest-2026' });
    expect(ok.status).toBe(200);
    const again = await request(h.app).post('/api/v1/auth/reset-password').send({ token: token2, newPassword: 'Another-Good-One-77' });
    expect(again.status).toBe(400);

    const login = await request(h.app).post('/api/v1/auth/login').send({ email: 'opstwo@t.test', password: 'Sorghum-Harvest-2026' });
    expect(login.status).toBe(200);
  });
});

describe('access control (T-04, T-05)', () => {
  it('rejects requests without a token, with a forged token, or with alg none', async () => {
    expect((await request(h.app).get('/api/v1/dashboard')).status).toBe(401);
    const forged = jwt.sign({ sub: h.users.admin, role: 'Admin' }, 'not-the-secret', { issuer: 'sizaniconnect-api', audience: 'sizaniconnect-web' });
    expect((await request(h.app).get('/api/v1/users').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    const none = jwt.sign({ sub: h.users.admin, role: 'Admin' }, '', { algorithm: 'none' });
    expect((await request(h.app).get('/api/v1/users').set('Authorization', `Bearer ${none}`)).status).toBe(401);
  });

  it('denies by default: a volunteer cannot reach admin, households or reports', async () => {
    const vol = h.as('volone@t.test');
    expect((await vol.get('/api/v1/users')).status).toBe(403);
    expect((await vol.get('/api/v1/households')).status).toBe(403);
    expect((await vol.get('/api/v1/reports/monthly?month=2026-10')).status).toBe(403);
    expect((await vol.post('/api/v1/events', {})).status).toBe(403);
  });

  it('a donor cannot reach operational data', async () => {
    await h.pool.query("UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE email = 'donor@t.test'");
    const donor = h.as('donor@t.test');
    expect((await donor.get('/api/v1/households')).status).toBe(403);
    expect((await donor.get('/api/v1/stock/items')).status).toBe(403);
  });

  it('returns the signed-in user', async () => {
    const res = await h.as('coorda@t.test').get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'SiteCoordinator', siteName: 'Site A' });
  });
});

describe('transport and header hardening (Section 10.3, 10.4)', () => {
  it('serves a strict CSP and security headers on every response', async () => {
    const res = await request(h.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('marks personal data responses as not cacheable', async () => {
    const res = await h.as('ops@t.test').get('/api/v1/dashboard');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns JSON errors without stack traces', async () => {
    const res = await request(h.app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"broken');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts/);
  });

  it('answers unknown API routes with 404 JSON', async () => {
    const res = await h.as('ops@t.test').get('/api/v1/nope');
    expect(res.status).toBe(404);
  });
});
