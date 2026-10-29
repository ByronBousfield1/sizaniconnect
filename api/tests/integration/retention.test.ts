import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonthsUtc } from '../../src/domain/time.js';
import { createHarness, newSaId, PASSWORD, type Harness } from './harness.js';

/**
 * Lecturer feedback on Task 2: "What happens if the user retires? How are they removed from the
 * database completely? Now think of the admin managing the process." Plus NFR-16 for households.
 */
let h: Harness;
const realNow = new Date();
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const admin = () => h.as('admin@t.test');
const login = (email: string, password = PASSWORD) => request(h.app).post('/api/v1/auth/login').send({ email, password });

async function futureShiftFor(userId: string) {
  const ev = await h.pool.query(
    `INSERT INTO distribution_events (site_id, scheduled_date, start_time, end_time, planned_parcels, created_by)
     VALUES ($1, current_date + 7, '08:00', '13:00', 50, $2) RETURNING event_id AS id`,
    [h.sites.A, h.users.ops],
  );
  const shift = await h.pool.query(
    `INSERT INTO volunteer_shifts (event_id, starts_at, ends_at, volunteers_needed)
     VALUES ($1, now() + interval '7 days', now() + interval '7 days 4 hours', 3) RETURNING shift_id AS id`,
    [ev.rows[0].id],
  );
  await h.pool.query('INSERT INTO shift_assignments (shift_id, user_id) VALUES ($1, $2)', [shift.rows[0].id, userId]);
}

describe('offboarding someone who has left', () => {
  it('stops the account at once, frees their future shifts and says when erasure is due', async () => {
    await login('volone@t.test'); // a live session to be ended
    await futureShiftFor(h.users.vol1);
    const reset = await admin().post(`/api/v1/users/${h.users.vol1}/reset-link`);
    expect(reset.status).toBe(201);
    const resetToken = /token=([\w-]+)/.exec(h.email.sent.at(-1)!.text)![1];

    const res = await admin().post(`/api/v1/users/${h.users.vol1}/offboard`, { reason: 'Retired' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ shiftsReleased: 1, siteLeftWithoutCoordinator: null });
    expect(res.body.erasureDueOn).toBe(new Date(realNow.getTime() + 30 * 86_400_000).toISOString().slice(0, 10));

    expect((await login('volone@t.test')).status).toBe(401);
    const live = await h.pool.query('SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [h.users.vol1]);
    expect(live.rows[0].n).toBe(0);
    expect((await request(h.app).post('/api/v1/auth/reset-password').send({ token: resetToken, newPassword: 'Sneaky-Way-Back-2026' })).status).toBe(400);
    const row = await h.pool.query('SELECT deactivation_reason AS r, deactivated_at AS d FROM users WHERE user_id = $1', [h.users.vol1]);
    expect(row.rows[0].r).toBe('Retired');
    expect(row.rows[0].d).not.toBeNull();
    expect(await h.auditCount('User', 'OFFBOARD')).toBe(1);
  });

  it('warns when a site is left without a coordinator', async () => {
    const res = await admin().post(`/api/v1/users/${h.users.coordB}/offboard`, { reason: 'Resigned' });
    expect(res.body.siteLeftWithoutCoordinator).toBe('Site B');
  });

  it('can be undone during the grace period', async () => {
    expect((await admin().patch(`/api/v1/users/${h.users.coordB}`, { isActive: true })).status).toBe(200);
    expect((await login('coordb@t.test')).status).toBe(200);
    const row = await h.pool.query('SELECT deactivated_at AS d FROM users WHERE user_id = $1', [h.users.coordB]);
    expect(row.rows[0].d).toBeNull();
  });

  it('refuses to offboard yourself, someone already offboarded, or without a reason', async () => {
    expect((await admin().post(`/api/v1/users/${h.users.admin}/offboard`, { reason: 'Retired' })).body.error.code).toBe('SELF_LOCKOUT');
    expect((await admin().post(`/api/v1/users/${h.users.vol1}/offboard`, { reason: 'Retired' })).body.error.code).toBe('ALREADY_OFFBOARDED');
    expect((await admin().post(`/api/v1/users/${h.users.vol2}/offboard`, {})).status).toBe(400);
    expect((await h.as('ops@t.test').post(`/api/v1/users/${h.users.vol2}/offboard`, { reason: 'Other' })).status).toBe(403);
  });
});

describe('erasing personal data', () => {
  it('only after offboarding, and only when the administrator types the email to confirm', async () => {
    expect((await admin().post(`/api/v1/users/${h.users.vol2}/erase`, { confirmEmail: 'voltwo@t.test' })).body.error.code).toBe('STILL_ACTIVE');
    const wrong = await admin().post(`/api/v1/users/${h.users.vol1}/erase`, { confirmEmail: 'someone-else@t.test' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.fields[0].field).toBe('confirmEmail');
  });

  it('deletes an account that was never used, completely', async () => {
    const created = await admin().post('/api/v1/users', { fullName: 'Never Started', email: 'never@t.test', role: 'Volunteer' });
    await admin().post(`/api/v1/users/${created.body.id}/offboard`, { reason: 'Other' });
    const res = await admin().post(`/api/v1/users/${created.body.id}/erase`, { confirmEmail: 'NEVER@t.test' });
    expect(res.body.outcome).toBe('Deleted');
    expect((await h.pool.query('SELECT count(*) AS n FROM users WHERE user_id = $1', [created.body.id])).rows[0].n).toBe(0);
    expect((await h.pool.query('SELECT count(*) AS n FROM password_reset_tokens WHERE user_id = $1', [created.body.id])).rows[0].n).toBe(0);
  });

  it('anonymises an account that has history, keeping the history but nothing that identifies the person', async () => {
    const res = await admin().post(`/api/v1/users/${h.users.vol1}/erase`, { confirmEmail: 'volone@t.test' });
    expect(res.body.outcome).toBe('Anonymised');

    const u = (await h.pool.query('SELECT * FROM users WHERE user_id = $1', [h.users.vol1])).rows[0];
    expect(u.full_name).toBe('Former user');
    expect(u.email).toBe(`erased-${h.users.vol1}@erased.invalid`);
    expect(u.phone_number).toBeNull();
    expect(u.erased_at).not.toBeNull();
    expect(JSON.stringify(u)).not.toMatch(/volone/i);
    expect((await h.pool.query('SELECT count(*) AS n FROM shift_assignments WHERE user_id = $1', [h.users.vol1])).rows[0].n).toBe(1);
    expect((await h.pool.query('SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1', [h.users.vol1])).rows[0].n).toBe(0);

    const erasure = (await h.pool.query(`SELECT details FROM audit_log WHERE action = 'ERASE' AND entity_id = $1`, [h.users.vol1])).rows[0];
    expect(erasure.details).toEqual({ outcome: 'Anonymised', role: 'Volunteer' });

    const list = await admin().get('/api/v1/users');
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(h.users.vol1);
    expect((await login('volone@t.test')).status).toBe(401);
  });

  it('cannot be repeated, reversed or edited afterwards', async () => {
    expect((await admin().post(`/api/v1/users/${h.users.vol1}/erase`, { confirmEmail: 'x' })).body.error.code).toBe('ALREADY_ERASED');
    expect((await admin().patch(`/api/v1/users/${h.users.vol1}`, { isActive: true })).body.error.code).toBe('ALREADY_ERASED');
  });
});

describe('the Data retention screen', () => {
  it('lists offboarded accounts with their erasure dates, marking the overdue ones', async () => {
    await admin().post(`/api/v1/users/${h.users.coordB}/offboard`, { reason: 'RoleEnded' });
    let o = await admin().get('/api/v1/retention');
    const row = o.body.usersAwaitingErasure.find((u: { id: string }) => u.id === h.users.coordB);
    expect(row).toMatchObject({ deactivationReason: 'RoleEnded', isDue: false });
    expect(o.body.erasedUserCount).toBe(1);

    h.setNow(new Date(realNow.getTime() + 31 * 86_400_000));
    o = await admin().get('/api/v1/retention');
    expect(o.body.usersAwaitingErasure.find((u: { id: string }) => u.id === h.users.coordB).isDue).toBe(true);
    h.setNow(realNow);
  });

  it('NFR-16: anonymises households archived for 24 months, keeping counts and collection history', async () => {
    const hh = await h.activeHousehold(3);
    const ev = await h.openEvent();
    await h.as('coorda@t.test').post('/api/v1/collections', { eventId: ev, householdId: hh.id });
    expect((await h.as('ops@t.test').post(`/api/v1/households/${hh.id}/archive`, { reason: 'Moved away' })).status).toBe(200);
    expect((await admin().get('/api/v1/retention')).body.householdsDue.total).toBe(0);

    h.setNow(addMonthsUtc(realNow, 25));
    const o = await admin().get('/api/v1/retention');
    expect(o.body.householdsDue.items.map((x: { referenceCode: string }) => x.referenceCode)).toContain(hh.referenceCode);
    const res = await admin().post('/api/v1/retention/households/anonymise');
    expect(res.body.anonymised).toBeGreaterThanOrEqual(1);
    h.setNow(realNow);

    const row = (await h.pool.query('SELECT * FROM households WHERE household_id = $1', [hh.id])).rows[0];
    expect(row).toMatchObject({ head_of_household: 'Anonymised household', id_number_hash: null, contact_number: null, status: 'Archived' });
    const members = (await h.pool.query('SELECT first_name, age_band FROM household_members WHERE household_id = $1', [hh.id])).rows;
    expect(members).toHaveLength(3);
    expect(members.every((m) => m.first_name === 'Removed')).toBe(true);
    expect((await h.pool.query('SELECT count(*) AS n FROM collections WHERE household_id = $1', [hh.id])).rows[0].n).toBe(1);
    expect(await h.auditCount('Household', 'ANONYMISE')).toBeGreaterThanOrEqual(1);
    expect((await admin().get('/api/v1/retention')).body.anonymisedHouseholdCount).toBeGreaterThanOrEqual(1);

    // The person can register again later as a new household.
    expect((await h.as('coorda@t.test').post('/api/v1/households', {
      headOfHousehold: 'Nomsa Dlamini', idNumber: newSaId(), addressLine: '1 New Road', suburb: 'Diepsloot', homeSiteId: h.sites.A,
      members: [{ firstName: 'Nomsa', ageBand: '18-59', dependantType: 'Self' }],
    })).status).toBe(201);
  });

  it('is for administrators only', async () => {
    expect((await h.as('ops@t.test').get('/api/v1/retention')).status).toBe(403);
    expect((await h.as('ops@t.test').post('/api/v1/retention/households/anonymise')).status).toBe(403);
  });
});
