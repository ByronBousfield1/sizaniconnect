import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildContainer } from '../../src/container.js';
import { logger } from '../../src/infra/logger.js';
import { createHarness, PASSWORD, TEST_DB, type Harness } from './harness.js';

/**
 * Lecturer feedback on Task 2: "What happens if the admin forgets the password? Can they reset
 * themselves?" Yes, three ways, none of which needs another person's password:
 *   1. the emailed reset link (when mail is configured)
 *   2. a recovery code saved in advance (works with no email at all)
 *   3. break-glass: a single-use link printed on the server console by whoever holds the Azure login
 * and a second administrator can also send a reset link.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const login = (email: string, password: string) => request(h.app).post('/api/v1/auth/login').send({ email, password });
const recover = (email: string, recoveryCode: string, newPassword: string) =>
  request(h.app).post('/api/v1/auth/recover').send({ email, recoveryCode, newPassword });

describe('recovery codes', () => {
  let codes: string[] = [];

  it('asks for the password again before creating codes', async () => {
    const res = await h.as('admin@t.test').post('/api/v1/auth/recovery-codes', { password: 'not-my-password' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields).toContainEqual({ field: 'password', message: 'That is not your current password.' });
  });

  it('creates ten single-use codes and stores only keyed hashes of them', async () => {
    const res = await h.as('admin@t.test').post('/api/v1/auth/recovery-codes', { password: PASSWORD });
    expect(res.status).toBe(201);
    codes = res.body.codes;
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    const stored = JSON.stringify((await h.pool.query('SELECT * FROM recovery_codes')).rows);
    for (const c of codes) expect(stored).not.toContain(c.replace('-', ''));
    expect((await h.as('admin@t.test').get('/api/v1/auth/recovery-codes')).body.remaining).toBe(10);
  });

  it('a signed-out administrator resets their own password with a code (typed in lower case, no hyphen)', async () => {
    const before = h.email.sent.length;
    const res = await recover('admin@t.test', codes[0].replace('-', '').toLowerCase(), 'Forgot-It-Again-2026');
    expect(res.status).toBe(200);
    expect(res.body.remainingCodes).toBe(9);
    expect((await login('admin@t.test', 'Forgot-It-Again-2026')).status).toBe(200);
    expect((await login('admin@t.test', PASSWORD)).status).toBe(401);
    expect(h.email.sent.length).toBe(before + 1); // "your password was changed" notice
    expect(h.email.sent.at(-1)!.subject).toMatch(/password was changed/);
    expect(await h.auditCount('User', 'PASSWORD_RECOVERED')).toBe(1);
  });

  it('a code works only once', async () => {
    const res = await recover('admin@t.test', codes[0], 'Another-Fresh-Phrase-1');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RECOVERY_FAILED');
  });

  it('gives the same answer for an unknown email as for a wrong code', async () => {
    const unknown = await recover('nobody@t.test', codes[1], 'Another-Fresh-Phrase-1');
    const wrong = await recover('ops@t.test', codes[1], 'Another-Fresh-Phrase-1'); // a real code, but not ops's
    expect(unknown.body.error).toEqual(wrong.body.error);
  });

  it('refuses a weak new password without using up the code', async () => {
    const res = await recover('admin@t.test', codes[1], 'short');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
    expect((await h.pool.query('SELECT count(*) AS n FROM recovery_codes WHERE used_at IS NULL')).rows[0].n).toBe(9);
  });

  it('wrong codes count towards the same lockout as wrong passwords', async () => {
    for (let i = 0; i < 4; i++) expect((await recover('coorda@t.test', 'AAAAA-AAAAA', 'Another-Fresh-Phrase-1')).status).toBe(400);
    expect((await recover('coorda@t.test', 'AAAAA-AAAAA', 'Another-Fresh-Phrase-1')).status).toBe(423);
    expect((await login('coorda@t.test', PASSWORD)).status).toBe(423);
    await h.pool.query('UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE email = $1', ['coorda@t.test']);
  });

  it('creating a new set retires the old codes', async () => {
    await h.as('admin@t.test').post('/api/v1/auth/recovery-codes', { password: 'Forgot-It-Again-2026' });
    expect((await recover('admin@t.test', codes[2], 'Another-Fresh-Phrase-1')).status).toBe(400);
  });
});

describe('changing a password while signed in', () => {
  it('needs the current password, keeps this device signed in and signs out the others', async () => {
    const phone = request.agent(h.app);
    const laptop = request.agent(h.app);
    const a = await phone.post('/api/v1/auth/login').send({ email: 'volone@t.test', password: PASSWORD });
    await laptop.post('/api/v1/auth/login').send({ email: 'volone@t.test', password: PASSWORD });
    const auth = { Authorization: `Bearer ${a.body.accessToken}` };

    const wrong = await phone.post('/api/v1/auth/change-password').set(auth).send({ currentPassword: 'nope', newPassword: 'Brand-New-Phrase-2026' });
    expect(wrong.body.error.details.fields[0].field).toBe('currentPassword');
    const same = await phone.post('/api/v1/auth/change-password').set(auth).send({ currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.body.error.code).toBe('SAME_PASSWORD');

    const ok = await phone.post('/api/v1/auth/change-password').set(auth).send({ currentPassword: PASSWORD, newPassword: 'Brand-New-Phrase-2026' });
    expect(ok.status).toBe(200);
    expect((await phone.post('/api/v1/auth/refresh')).status).toBe(200);
    expect((await laptop.post('/api/v1/auth/refresh')).status).toBe(401);
  });
});

describe('an administrator helping someone who is locked out', () => {
  it('sends a 24-hour reset link to another administrator', async () => {
    const created = await h.as('admin@t.test').post('/api/v1/users', { fullName: 'Second Admin', email: 'admin2@t.test', role: 'Admin' });
    await h.pool.query('UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email = $1) WHERE user_id = $2', ['ops@t.test', created.body.id]);
    const res = await h.as('admin@t.test').post(`/api/v1/users/${created.body.id}/reset-link`);
    expect(res.status).toBe(201);
    expect(res.body.link).toBeUndefined(); // mail is configured in tests, so the link goes by email only
    const token = /token=([\w-]+)/.exec(h.email.sent.at(-1)!.text)![1];
    expect((await request(h.app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'Second-Admin-Phrase-26' })).status).toBe(200);
    expect((await login('admin2@t.test', 'Second-Admin-Phrase-26')).status).toBe(200);
    expect(await h.auditCount('User', 'PASSWORD_RESET_ISSUED')).toBe(1);
  });

  it('only administrators can do it', async () => {
    expect((await h.as('ops@t.test').post(`/api/v1/users/${h.users.admin}/reset-link`)).status).toBe(403);
  });
});

describe('break-glass recovery from the server console', () => {
  it('prints a working single-use link for an administrator and records the use', async () => {
    // What `node dist/db/cli.js recover-admin <email>` does.
    const { services } = buildContainer(loadConfig({ databaseUrl: TEST_DB, pbkdf2Iterations: 1000 }), h.pool, logger);
    const { link } = await services.auth.issueBreakGlassLink('admin@t.test');
    const token = new URL(link).searchParams.get('token');
    expect((await request(h.app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'Break-Glass-Phrase-26' })).status).toBe(200);
    expect((await request(h.app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'Break-Glass-Phrase-27' })).status).toBe(400);
    expect(await h.auditCount('User', 'BREAK_GLASS_RESET')).toBe(1);
    await expect(services.auth.issueBreakGlassLink('ops@t.test')).rejects.toMatchObject({ code: 'NOT_AN_ADMIN' });
  });
});
