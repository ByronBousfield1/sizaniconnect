import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cardPayload, REFERENCE_CODE_PATTERN } from '../../src/domain/referenceCode.js';
import { createHarness, newSaId, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const body = (over: Record<string, unknown> = {}) => ({
  headOfHousehold: 'Thabo Mokoena',
  idNumber: newSaId(),
  contactNumber: '072 123 4567',
  addressLine: '45 Ubuntu Close',
  suburb: 'Diepsloot',
  homeSiteId: h.sites.A,
  members: [
    { firstName: 'Thabo', ageBand: '18-59', dependantType: 'Self' },
    { firstName: 'Lerato', ageBand: '6-12', dependantType: 'Child' },
  ],
  ...over,
});

describe('SD-01 household registration (US-01, US-02)', () => {
  it('registers a household as pending verification with a reference code', async () => {
    const res = await h.as('coorda@t.test').post('/api/v1/households', body());
    expect(res.status).toBe(201);
    expect(res.body.referenceCode).toMatch(REFERENCE_CODE_PATTERN);
    expect(res.body).toMatchObject({ status: 'PendingVerification', parcelSize: 'Small' });
    expect(await h.auditCount('Household', 'CREATE')).toBeGreaterThan(0);
  });

  it('never stores the identity number itself (NFR-15)', async () => {
    const id = newSaId();
    await h.as('coorda@t.test').post('/api/v1/households', body({ idNumber: id }));
    const raw = await h.pool.query('SELECT * FROM households');
    expect(JSON.stringify(raw.rows)).not.toContain(id);
  });

  it('BR-01: blocks the same person registering twice, across sites', async () => {
    const id = newSaId();
    const first = await h.as('coorda@t.test').post('/api/v1/households', body({ idNumber: id }));
    const second = await h.as('coordb@t.test').post('/api/v1/households', body({ idNumber: id, homeSiteId: h.sites.B }));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE_HOUSEHOLD');
    expect(second.body.error.details.referenceCode).toBe(first.body.referenceCode);
  });

  it('allows re-registration once the old record is archived', async () => {
    const id = newSaId();
    const first = await h.as('coorda@t.test').post('/api/v1/households', body({ idNumber: id }));
    await h.pool.query("UPDATE households SET status = 'Archived' WHERE household_id = $1", [first.body.id]);
    const again = await h.as('coorda@t.test').post('/api/v1/households', body({ idNumber: id }));
    expect(again.status).toBe(201);
  });

  it('rejects an invalid SA ID number', async () => {
    const res = await h.as('coorda@t.test').post('/api/v1/households', body({ idNumber: '8001015009088' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ID_NUMBER');
  });

  it('requires exactly one head of household', async () => {
    const res = await h.as('coorda@t.test').post(
      '/api/v1/households',
      body({ members: [{ firstName: 'Lerato', ageBand: '6-12', dependantType: 'Child' }] }),
    );
    expect(res.body.error.code).toBe('HEAD_REQUIRED');
  });

  it('confines coordinators to their own site', async () => {
    const res = await h.as('coorda@t.test').post('/api/v1/households', body({ homeSiteId: h.sites.B }));
    expect(res.status).toBe(403);
  });

  it('does not let volunteers register households', async () => {
    expect((await h.as('volone@t.test').post('/api/v1/households', body())).status).toBe(403);
  });
});

describe('T-02 cross-site scripting at the API boundary', () => {
  it('rejects markup in name fields', async () => {
    const res = await h.as('coorda@t.test').post('/api/v1/households', body({ headOfHousehold: '<img src=x onerror=alert(1)>' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('stores free text inertly and returns it as JSON data, never as HTML', async () => {
    const payload = '45 Ubuntu Close <script>alert(1)</script>';
    const created = await h.as('coorda@t.test').post('/api/v1/households', body({ addressLine: payload }));
    const read = await h.as('ops@t.test').get(`/api/v1/households/${created.body.id}`);
    expect(read.headers['content-type']).toMatch(/application\/json/);
    expect(read.body.addressLine).toBe(payload);
  });
});

describe('T-03 SQL injection', () => {
  it('treats injection attempts in search as plain text', async () => {
    const res = await h.as('ops@t.test').get(`/api/v1/households?q=${encodeURIComponent("x' OR '1'='1")}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    const still = await h.pool.query('SELECT count(*) AS n FROM households');
    expect(still.rows[0].n).toBeGreaterThan(0);
  });

  it('escapes LIKE wildcards', async () => {
    const res = await h.as('ops@t.test').get('/api/v1/households?q=%25');
    expect(res.body.total).toBe(0);
  });
});

describe('verification and lifecycle (US-03, BR-03)', () => {
  it('four-eyes: the manager who registered a household cannot verify it', async () => {
    const reg = await h.as('ops@t.test').post('/api/v1/households', body());
    const self = await h.as('ops@t.test').post(`/api/v1/households/${reg.body.id}/verify`);
    expect(self.status).toBe(403);
    const other = await h.as('opstwo@t.test').post(`/api/v1/households/${reg.body.id}/verify`);
    expect(other.status).toBe(200);
    expect(other.body.status).toBe('Active');
  });

  it('coordinators cannot verify', async () => {
    const reg = await h.as('coorda@t.test').post('/api/v1/households', body());
    expect((await h.as('coorda@t.test').post(`/api/v1/households/${reg.body.id}/verify`)).status).toBe(403);
  });

  it('suspension needs a reason, and illegal transitions are refused', async () => {
    const { id } = await h.activeHousehold();
    expect((await h.as('coorda@t.test').post(`/api/v1/households/${id}/suspend`, {})).body.error.code).toBe('REASON_REQUIRED');
    expect((await h.as('coorda@t.test').post(`/api/v1/households/${id}/suspend`, { reason: 'Duplicate visit under review' })).status).toBe(200);
    expect((await h.as('ops@t.test').post(`/api/v1/households/${id}/verify`)).body.error.code).toBe('INVALID_STATUS_CHANGE');
    expect((await h.as('ops@t.test').post(`/api/v1/households/${id}/reinstate`)).body.status).toBe('Active');
  });

  it('return for correction, edit, resubmit', async () => {
    const reg = await h.as('coorda@t.test').post('/api/v1/households', body());
    expect((await h.as('ops@t.test').post(`/api/v1/households/${reg.body.id}/return`, { reason: 'Address incomplete' })).body.status).toBe('Draft');
    expect((await h.as('coorda@t.test').patch(`/api/v1/households/${reg.body.id}`, { addressLine: '45 Ubuntu Close, Ext 2' })).status).toBe(200);
    expect((await h.as('coorda@t.test').post(`/api/v1/households/${reg.body.id}/resubmit`)).body.status).toBe('PendingVerification');
  });

  it('records audit entries without copying personal values', async () => {
    const { id } = await h.activeHousehold();
    await h.as('coorda@t.test').patch(`/api/v1/households/${id}`, { contactNumber: '083 999 1111' });
    const rows = await h.pool.query("SELECT details FROM audit_log WHERE entity_id = $1 AND action = 'UPDATE'", [id]);
    expect(rows.rows[0].details).toEqual({ fields: ['contactNumber'] });
    expect(JSON.stringify(rows.rows)).not.toContain('083 999 1111');
  });

  it('the audit log is append-only at the database level (NFR-17)', async () => {
    await expect(h.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(h.pool.query("UPDATE audit_log SET action = 'X'")).rejects.toThrow(/append-only/);
  });
});

describe('desk lookup (US-04)', () => {
  it('finds by reference code, forgiving misread characters, and returns only what the desk needs', async () => {
    const { referenceCode } = await h.activeHousehold(6);
    const typed = referenceCode.toLowerCase().replace(/0/g, 'o');
    const res = await h.as('volone@t.test').get(`/api/v1/households/by-ref/${typed}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ referenceCode, status: 'Active', parcelSize: 'Large', memberCount: 6 });
    expect(res.body.addressLine).toBeUndefined();
    expect(res.body.contactNumber).toBeUndefined();
  });

  it('searches by name with paging', async () => {
    const res = await h.as('ops@t.test').get('/api/v1/households?q=nomsa&pageSize=2');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(2);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('exports subject data for a POPIA access request and audits the export', async () => {
    const { id } = await h.activeHousehold();
    const res = await h.as('ops@t.test').get(`/api/v1/households/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.body.household.members.length).toBe(4);
    expect(await h.auditCount('Household', 'SUBJECT_ACCESS_EXPORT')).toBe(1);
  });

  it('archives households inactive for 12 months (BR-08)', async () => {
    const { id } = await h.activeHousehold();
    await h.pool.query("UPDATE households SET registered_on = now() - interval '13 months' WHERE household_id = $1", [id]);
    const res = await h.as('ops@t.test').post('/api/v1/households/archive-inactive');
    expect(res.body.archived).toBeGreaterThanOrEqual(1);
    expect((await h.as('ops@t.test').get(`/api/v1/households/${id}`)).body.status).toBe('Archived');
  });
});

describe('cellphone validation (Task 2 feedback)', () => {
  it('stores any accepted spelling in one form', async () => {
    const res = await h.as('coorda@t.test').post('/api/v1/households', body({ contactNumber: '+27 (82) 555-0134' }));
    expect(res.status).toBe(201);
    const row = await h.pool.query('SELECT contact_number AS c FROM households WHERE household_id = $1', [res.body.id]);
    expect(row.rows[0].c).toBe('+27825550134');
  });

  it('refuses a landline with a field message that says what to do', async () => {
    const res = await h.as('coorda@t.test').post('/api/v1/households', body({ contactNumber: '011 555 0134' }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields).toContainEqual({ field: 'contactNumber', message: 'That is a landline number. Enter a cellphone number instead.' });
  });

  it('allows no number at all', async () => {
    const res = await h.as('coorda@t.test').post('/api/v1/households', body({ contactNumber: '' }));
    expect(res.status).toBe(201);
  });

  it('applies the same rule to staff accounts, and a PATCH without the field leaves the number alone', async () => {
    const bad = await h.as('admin@t.test').post('/api/v1/users', { fullName: 'Cell Test', email: 'celltest@t.test', phoneNumber: '0800 000 000', role: 'Volunteer' });
    expect(bad.status).toBe(400);
    const ok = await h.as('admin@t.test').post('/api/v1/users', { fullName: 'Cell Test', email: 'celltest@t.test', phoneNumber: '072 000 1111', role: 'Volunteer' });
    expect(ok.status).toBe(201);
    await h.as('admin@t.test').patch(`/api/v1/users/${ok.body.id}`, { fullName: 'Cell Tested' });
    const row = await h.pool.query('SELECT phone_number AS p FROM users WHERE user_id = $1', [ok.body.id]);
    expect(row.rows[0].p).toBe('+27720001111');
  });
});

describe('scanning household cards at the desk (US-09)', () => {
  it('finds a household from its card payload and refuses damaged or foreign scans without searching', async () => {
    const hh = await h.activeHousehold();
    const vol = h.as('volone@t.test');
    const ok = await vol.get(`/api/v1/households/by-ref/${encodeURIComponent(cardPayload(hh.referenceCode))}`);
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(hh.id);

    const damaged = await vol.get(`/api/v1/households/by-ref/${encodeURIComponent(cardPayload(hh.referenceCode).slice(0, -1) + 'Z')}`);
    const foreign = await vol.get(`/api/v1/households/by-ref/${encodeURIComponent('https://example.com')}`);
    // One of the two checks could in theory pass by chance if Z happens to be the right character.
    if (!cardPayload(hh.referenceCode).endsWith('Z')) expect(damaged.body.error.code).toBe('CARD_UNREADABLE');
    expect(foreign.body.error.code).toBe('NOT_A_REFERENCE_CODE');
    expect((await vol.get('/api/v1/households/by-ref/SZN-2026-000000')).status).toBe(404);
  });
});
