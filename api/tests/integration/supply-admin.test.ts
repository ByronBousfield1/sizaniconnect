import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/domain/time.js';
import { createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('SD-03 donations (US-12)', () => {
  it('captures an in-kind donation as stock batches with a sequential receipt', async () => {
    const res = await h.as('ops@t.test').post('/api/v1/donations', {
      donorId: h.donors.d1,
      donationType: 'InKind',
      receivedOn: h.today,
      lines: [
        { stockItemId: h.items.maize, quantity: 40, expiryDate: addDays(h.today, 120) },
        { stockItemId: h.items.beans, quantity: 60, expiryDate: null },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.receiptNumber).toMatch(/^SZN-R-\d{4}-\d{6}$/);
    const detail = await h.as('ops@t.test').get(`/api/v1/donations/${res.body.id}`);
    expect(detail.body.lines).toHaveLength(2);
    expect(h.email.sent.at(-1)!.subject).toContain(res.body.receiptNumber);
  });

  it('validates cash and in-kind rules', async () => {
    const ops = h.as('ops@t.test');
    expect((await ops.post('/api/v1/donations', { donorId: h.donors.d2, donationType: 'Cash', receivedOn: h.today })).body.error.code).toBe('AMOUNT_REQUIRED');
    expect((await ops.post('/api/v1/donations', { donorId: h.donors.d2, donationType: 'InKind', receivedOn: h.today, lines: [] })).body.error.code).toBe('LINES_REQUIRED');
    expect((await ops.post('/api/v1/donations', { donorId: h.donors.d2, donationType: 'Cash', monetaryValue: 10, receivedOn: addDays(h.today, 1) })).body.error.code).toBe('DATE_IN_FUTURE');
    expect((await ops.post('/api/v1/donations', {
      donorId: h.donors.d2, donationType: 'InKind', receivedOn: h.today,
      lines: [{ stockItemId: h.items.maize, quantity: 1, expiryDate: addDays(h.today, -1) }],
    })).body.error.code).toBe('EXPIRED_ON_RECEIPT');
    expect((await ops.post('/api/v1/donations', { donorId: h.donors.d2, donationType: 'Cash', monetaryValue: 750, receivedOn: h.today })).status).toBe(201);
  });

  it('creates donors', async () => {
    const res = await h.as('ops@t.test').post('/api/v1/donors', { donorName: 'Spaza Collective', donorType: 'Corporate', contactEmail: '' });
    expect(res.status).toBe(201);
    expect((await h.as('ops@t.test').get('/api/v1/donors')).body.some((d: { donorName: string }) => d.donorName === 'Spaza Collective')).toBe(true);
  });
});

describe('stock (US-13, US-14)', () => {
  it('reports on-hand excluding expired stock, and raises alerts', async () => {
    const items = await h.as('ops@t.test').get('/api/v1/stock/items');
    const beans = items.body.find((i: { itemName: string }) => i.itemName === 'Beans');
    expect(beans.belowReorder).toBe(true); // reorder level 500
    const alerts = await h.as('ops@t.test').get('/api/v1/stock/alerts');
    expect(alerts.body.lowStock.map((i: { itemName: string }) => i.itemName)).toContain('Beans');
    expect(alerts.body.expiring.map((b: { batchId: string }) => b.batchId)).toContain(h.batches.maizeEarly);
    expect(alerts.body.expired.map((b: { batchId: string }) => b.batchId)).toContain(h.batches.maizeExpired);
  });

  it('writes off an expired batch with a reason and a ledger entry', async () => {
    const ops = h.as('ops@t.test');
    expect((await ops.post(`/api/v1/stock/batches/${h.batches.maizeExpired}/write-off`, { reason: 'x' })).status).toBe(400);
    const res = await ops.post(`/api/v1/stock/batches/${h.batches.maizeExpired}/write-off`, { reason: 'Expired, sent to compost' });
    expect(res.body.writtenOff).toBe(50);
    expect(await h.remaining(h.batches.maizeExpired)).toBe(0);
    expect((await ops.post(`/api/v1/stock/batches/${h.batches.maizeExpired}/write-off`, { reason: 'Expired again' })).body.error.code).toBe('NOTHING_TO_WRITE_OFF');
  });

  it('lists batches per item and the parcel bill of materials', async () => {
    const batches = await h.as('ops@t.test').get(`/api/v1/stock/items/${h.items.maize}/batches`);
    expect(batches.body.batches.length).toBeGreaterThanOrEqual(3);
    const parcels = await h.as('volone@t.test').get('/api/v1/parcels');
    expect(parcels.body).toHaveLength(6);
  });

  it('creates stock items (operations manager only)', async () => {
    const body = { itemName: 'Samp 5 kg', category: 'Staples', unitOfMeasure: 'bag', reorderLevel: 20 };
    expect((await h.as('coorda@t.test').post('/api/v1/stock/items', body)).status).toBe(403);
    expect((await h.as('ops@t.test').post('/api/v1/stock/items', body)).status).toBe(201);
  });
});

describe('donor portal (US-16, US-17, T-04)', () => {
  it('shows a donor their own history and impact', async () => {
    const res = await h.as('donor@t.test').get('/api/v1/me/impact');
    expect(res.status).toBe(200);
    expect(res.body.donations.every((d: { donorId: string }) => d.donorId === h.donors.d1)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it("returns 404, not 403, for another donor's donation", async () => {
    const other = await h.as('ops@t.test').post('/api/v1/donations', { donorId: h.donors.d2, donationType: 'Cash', monetaryValue: 99, receivedOn: h.today });
    const res = await h.as('donor@t.test').get(`/api/v1/donations/${other.body.id}`);
    expect(res.status).toBe(404);
    expect((await h.as('donor@t.test').get(`/api/v1/donations/${h.donation1}`)).status).toBe(200);
  });

  it('cannot list all donations', async () => {
    expect((await h.as('donor@t.test').get('/api/v1/donations')).status).toBe(403);
  });
});

describe('administration (US-18, US-19)', () => {
  it('creates a user who activates their account from the emailed link', async () => {
    const res = await h.as('admin@t.test').post('/api/v1/users', { fullName: 'Zodwa Mthembu', email: 'zodwa@t.test', role: 'Volunteer' });
    expect(res.status).toBe(201);
    expect(res.body.activationLink).toBeUndefined(); // mail is configured, so the link goes by email only
    const link = h.email.sent.at(-1)!.text;
    const token = /token=([\w-]+)/.exec(link)![1];

    expect((await request(h.app).post('/api/v1/auth/login').send({ email: 'zodwa@t.test', password: 'anything-at-all' })).status).toBe(401);
    expect((await request(h.app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'Spinach-Rows-2026' })).status).toBe(200);
    expect((await request(h.app).post('/api/v1/auth/login').send({ email: 'zodwa@t.test', password: 'Spinach-Rows-2026' })).status).toBe(200);
  });

  it('enforces role links and unique email', async () => {
    const admin = h.as('admin@t.test');
    expect((await admin.post('/api/v1/users', { fullName: 'No Site', email: 'nosite@t.test', role: 'SiteCoordinator' })).body.error.code).toBe('SITE_REQUIRED');
    expect((await admin.post('/api/v1/users', { fullName: 'No Donor', email: 'nodonor@t.test', role: 'Donor' })).body.error.code).toBe('DONOR_REQUIRED');
    expect((await admin.post('/api/v1/users', { fullName: 'Dup', email: 'OPS@t.test', role: 'Volunteer' })).body.error.code).toBe('EMAIL_IN_USE');
  });

  it('protects against locking out the last administrator', async () => {
    const res = await h.as('admin@t.test').patch(`/api/v1/users/${h.users.admin}`, { isActive: false });
    expect(res.body.error.code).toBe('SELF_LOCKOUT');
  });

  it('deactivating a user ends their sessions', async () => {
    await request(h.app).post('/api/v1/auth/login').send({ email: 'voltwo@t.test', password: 'Correct-Horse-Battery-9' });
    expect((await h.as('admin@t.test').patch(`/api/v1/users/${h.users.vol2}`, { isActive: false })).status).toBe(200);
    const active = await h.pool.query('SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [h.users.vol2]);
    expect(active.rows[0].n).toBe(0);
    expect((await request(h.app).post('/api/v1/auth/login').send({ email: 'voltwo@t.test', password: 'Correct-Horse-Battery-9' })).status).toBe(401);
  });

  it('manages sites', async () => {
    const created = await h.as('admin@t.test').post('/api/v1/sites', { siteName: 'Soweto Hall', suburb: 'Soweto', capacityPerEvent: 80 });
    expect(created.status).toBe(201);
    expect((await h.as('admin@t.test').patch(`/api/v1/sites/${created.body.id}`, { isActive: false })).status).toBe(200);
    expect((await h.as('admin@t.test').post('/api/v1/sites', { siteName: 'Soweto Hall', suburb: 'Soweto', capacityPerEvent: 80 })).body.error.code).toBe('SITE_EXISTS');
  });

  it('shows a filterable audit trail to administrators only', async () => {
    const res = await h.as('admin@t.test').get('/api/v1/audit?entityName=User&pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((i: { entityName: string }) => i.entityName === 'User')).toBe(true);
    expect((await h.as('ops@t.test').get('/api/v1/audit')).status).toBe(403);
  });

  it('builds a role-shaped dashboard', async () => {
    const res = await h.as('coorda@t.test').get('/api/v1/dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('households');
    expect(res.body).toHaveProperty('upcomingEvents');
  });
});
