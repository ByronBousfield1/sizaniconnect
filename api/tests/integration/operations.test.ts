import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/domain/time.js';
import { createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('scheduling (US-05)', () => {
  it('schedules an event and refuses past dates and over-capacity plans', async () => {
    const ops = h.as('ops@t.test');
    const base = { siteId: h.sites.A, scheduledDate: addDays(h.today, 3), startTime: '09:00', endTime: '13:00', plannedParcels: 20 };
    expect((await ops.post('/api/v1/events', base)).status).toBe(201);
    expect((await ops.post('/api/v1/events', { ...base, scheduledDate: addDays(h.today, -1) })).body.error.code).toBe('DATE_IN_PAST');
    expect((await ops.post('/api/v1/events', { ...base, plannedParcels: 101 })).body.error.code).toBe('CAPACITY_EXCEEDED');
    expect((await ops.post('/api/v1/events', { ...base, startTime: '9am' })).status).toBe(400);
  });
});

describe('event lifecycle with stock and volunteers (BR-07)', () => {
  let eventId: string;

  it('refuses to stock an event when there is not enough unexpired stock', async () => {
    const res = await h.as('ops@t.test').post('/api/v1/events', {
      siteId: h.sites.A, scheduledDate: h.today, startTime: '00:00', endTime: '23:59', plannedParcels: 100, minVolunteers: 1,
    });
    // 100 medium parcels need 100 maize (110 unexpired on hand) and 200 beans (200 on hand). Remove some beans.
    await h.pool.query('UPDATE stock_batches SET quantity_remaining = 150 WHERE batch_id = $1', [h.batches.beans]);
    const stock = await h.as('ops@t.test').post(`/api/v1/events/${res.body.id}/stock`);
    expect(stock.status).toBe(409);
    expect(stock.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(stock.body.error.details.shortfalls).toEqual([
      { itemName: 'Beans', unitOfMeasure: 'pack', required: 200, available: 150 },
    ]);
    await h.pool.query('UPDATE stock_batches SET quantity_remaining = 200 WHERE batch_id = $1', [h.batches.beans]);
  });

  it('stocks, then will not open until enough volunteers have checked in', async () => {
    const created = await h.as('ops@t.test').post('/api/v1/events', {
      siteId: h.sites.A, scheduledDate: h.today, startTime: '00:00', endTime: '23:59', plannedParcels: 10, minVolunteers: 1,
    });
    eventId = created.body.id;
    expect((await h.as('ops@t.test').post(`/api/v1/events/${eventId}/stock`)).body.status).toBe('Stocked');

    const notYet = await h.as('coorda@t.test').post(`/api/v1/events/${eventId}/open`);
    expect(notYet.status).toBe(409);
    expect(notYet.body.error.code).toBe('NOT_ENOUGH_VOLUNTEERS');

    const start = new Date(Date.now() - 30 * 60_000).toISOString();
    const end = new Date(Date.now() + 4 * 3_600_000).toISOString();
    const shift = await h.as('coorda@t.test').post('/api/v1/shifts', { eventId, startsAt: start, endsAt: end, volunteersNeeded: 2 });
    expect(shift.status).toBe(201);
    // Sign-up closes once a shift starts, so the volunteer is assigned directly for this test.
    await h.pool.query('INSERT INTO shift_assignments (shift_id, user_id) VALUES ($1, $2)', [shift.body.id, h.users.vol1]);
    expect((await h.as('volone@t.test').post(`/api/v1/shifts/${shift.body.id}/checkin`)).body.status).toBe('CheckedIn');

    expect((await h.as('coordb@t.test').post(`/api/v1/events/${eventId}/open`)).status).toBe(403); // wrong site
    expect((await h.as('coorda@t.test').post(`/api/v1/events/${eventId}/open`)).body.status).toBe('Open');
  });

  it('SD-02: records a collection and deducts stock first-expiry-first-out', async () => {
    const hh = await h.activeHousehold(4); // medium parcel: 1 maize, 2 beans
    const res = await h.as('volone@t.test').post('/api/v1/collections', { eventId, householdId: hh.id });
    expect(res.status).toBe(201);
    expect(res.body.parcelSize).toBe('Medium');
    expect(await h.remaining(h.batches.maizeEarly)).toBe(9); // earliest expiry used first
    expect(await h.remaining(h.batches.maizeLate)).toBe(100);
    expect(await h.remaining(h.batches.maizeExpired)).toBe(50); // expired stock never issued
    expect(await h.remaining(h.batches.beans)).toBe(198);
    const movements = await h.pool.query("SELECT count(*) AS n FROM stock_movements WHERE collection_id = $1 AND movement_type = 'Issue'", [res.body.id]);
    expect(movements.rows[0].n).toBe(2);
  });

  it('BR-04: a second parcel at the same event is blocked unless a coordinator overrides with a reason', async () => {
    const hh = await h.activeHousehold(2);
    expect((await h.as('volone@t.test').post('/api/v1/collections', { eventId, householdId: hh.id })).status).toBe(201);

    const dup = await h.as('volone@t.test').post('/api/v1/collections', { eventId, householdId: hh.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_COLLECTION');
    expect(dup.body.error.details.verifiedByName).toBeTruthy();

    const lookup = await h.as('volone@t.test').get(`/api/v1/households/by-ref/${hh.referenceCode}?eventId=${eventId}`);
    expect(lookup.body.alreadyCollected).not.toBeNull();

    expect((await h.as('volone@t.test').post('/api/v1/collections', { eventId, householdId: hh.id, override: true, overrideReason: 'Baby born this week' })).status).toBe(403);
    expect((await h.as('coorda@t.test').post('/api/v1/collections', { eventId, householdId: hh.id, override: true, overrideReason: 'short' })).body.error.code).toBe('OVERRIDE_REASON_REQUIRED');
    const ok = await h.as('coorda@t.test').post('/api/v1/collections', { eventId, householdId: hh.id, override: true, overrideReason: 'Second household member arrived from Limpopo' });
    expect(ok.status).toBe(201);
    expect(ok.body.isOverride).toBe(true);
    expect(await h.auditCount('Collection', 'OVERRIDE')).toBe(1);
  });

  it('the database settles a race between two devices recording the same household', async () => {
    const hh = await h.activeHousehold(1);
    const [a, b] = await Promise.all([
      h.as('volone@t.test').post('/api/v1/collections', { eventId, householdId: hh.id }),
      h.as('voltwo@t.test').post('/api/v1/collections', { eventId, householdId: hh.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const rows = await h.pool.query('SELECT count(*) AS n FROM collections WHERE household_id = $1', [hh.id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('BR-02: a household that is not active cannot collect', async () => {
    const reg = await h.as('coorda@t.test').post('/api/v1/households', {
      headOfHousehold: 'Pending Person', idNumber: 'P1234567', addressLine: '1 Road', suburb: 'Diepsloot', homeSiteId: h.sites.A,
      members: [{ firstName: 'Pending', ageBand: '18-59', dependantType: 'Self' }],
    });
    const res = await h.as('volone@t.test').post('/api/v1/collections', { eventId, householdId: reg.body.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOUSEHOLD_NOT_ELIGIBLE');
  });

  it('rolls the whole collection back when one item runs out', async () => {
    const hh = await h.activeHousehold(9); // large parcel: 2 maize, 3 beans
    await h.pool.query('UPDATE stock_batches SET quantity_remaining = 1 WHERE batch_id = $1', [h.batches.beans]);
    const before = await h.remaining(h.batches.maizeEarly);
    const res = await h.as('volone@t.test').post('/api/v1/collections', { eventId, householdId: hh.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await h.remaining(h.batches.maizeEarly)).toBe(before);
    const rows = await h.pool.query('SELECT count(*) AS n FROM collections WHERE household_id = $1', [hh.id]);
    expect(rows.rows[0].n).toBe(0);
    await h.pool.query('UPDATE stock_batches SET quantity_remaining = 150 WHERE batch_id = $1', [h.batches.beans]);
  });

  it('US-11: closes, then reconciles only with an explained variance', async () => {
    const closed = await h.as('coorda@t.test').post(`/api/v1/events/${eventId}/close`);
    expect(closed.body.status).toBe('Closed');
    const system = closed.body.systemCount as number;

    expect((await h.as('volone@t.test').post('/api/v1/collections', { eventId, householdId: (await h.activeHousehold()).id })).body.error.code).toBe('EVENT_NOT_OPEN');

    const unexplained = await h.as('coorda@t.test').post(`/api/v1/events/${eventId}/reconcile`, { physicalCount: system - 1 });
    expect(unexplained.body.error.code).toBe('VARIANCE_REASON_REQUIRED');
    const ok = await h.as('coorda@t.test').post(`/api/v1/events/${eventId}/reconcile`, { physicalCount: system - 1, varianceReason: 'One parcel torn and returned to depot' });
    expect(ok.body).toMatchObject({ status: 'Reconciled', variance: -1 });

    const hours = await h.pool.query("SELECT hours_served FROM shift_assignments WHERE status = 'CheckedIn'");
    expect(hours.rows[0].hours_served).toBeGreaterThanOrEqual(0);
  });

  it('US-15: the monthly report reflects the event', async () => {
    const month = h.today.slice(0, 7);
    const res = await h.as('ops@t.test').get(`/api/v1/reports/monthly?month=${month}`);
    const siteA = res.body.sites.find((s: { siteName: string }) => s.siteName === 'Site A');
    expect(siteA.parcelsIssued).toBeGreaterThanOrEqual(4);
    expect(siteA.overrides).toBe(1);
    expect(res.body.totals.householdsServed).toBe(siteA.householdsServed);

    const csv = await h.as('ops@t.test').get(`/api/v1/reports/monthly.csv?month=${month}`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('Site,Events held,Households served,Parcels issued,Overrides,Volunteer hours');
  });

  it('neutralises spreadsheet formulas in CSV exports', async () => {
    await h.pool.query("INSERT INTO distribution_sites (site_name, suburb, capacity_per_event) VALUES ('=HYPERLINK(\"http://x\")', 'X', 1)");
    const csv = await h.as('ops@t.test').get(`/api/v1/reports/monthly.csv?month=${h.today.slice(0, 7)}`);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://x"")"`);
  });

  it('cancels only events that have not opened', async () => {
    const created = await h.as('ops@t.test').post('/api/v1/events', {
      siteId: h.sites.B, scheduledDate: addDays(h.today, 5), startTime: '09:00', endTime: '12:00', plannedParcels: 5,
    });
    expect((await h.as('ops@t.test').post(`/api/v1/events/${created.body.id}/cancel`, { reason: 'Hall flooded' })).body.status).toBe('Cancelled');
    expect((await h.as('ops@t.test').post(`/api/v1/events/${eventId}/cancel`, { reason: 'Too late now' })).body.error.code).toBe('INVALID_STATUS_CHANGE');
  });
});

describe('volunteer shifts (US-06, US-07, US-08, BR-10)', () => {
  let futureEvent: string;
  let shiftId: string;

  beforeAll(async () => {
    const ev = await h.as('ops@t.test').post('/api/v1/events', {
      siteId: h.sites.A, scheduledDate: addDays(h.today, 5), startTime: '09:00', endTime: '13:00', plannedParcels: 5,
    });
    futureEvent = ev.body.id;
    const starts = new Date(Date.now() + 5 * 86_400_000);
    const shift = await h.as('ops@t.test').post('/api/v1/shifts', {
      eventId: futureEvent, startsAt: starts.toISOString(), endsAt: new Date(starts.getTime() + 4 * 3_600_000).toISOString(), volunteersNeeded: 1,
    });
    shiftId = shift.body.id;
  });

  it('lists open shifts on the board with places remaining', async () => {
    const res = await h.as('volone@t.test').get('/api/v1/shifts');
    const shift = res.body.find((s: { id: string }) => s.id === shiftId);
    expect(shift).toMatchObject({ volunteersNeeded: 1, filled: 0, myStatus: null });
  });

  it('signs up, refuses a full shift, and refuses a double sign-up', async () => {
    expect((await h.as('volone@t.test').post(`/api/v1/shifts/${shiftId}/signup`)).body.status).toBe('Assigned');
    expect((await h.as('volone@t.test').post(`/api/v1/shifts/${shiftId}/signup`)).body.error.code).toBe('ALREADY_SIGNED_UP');
    expect((await h.as('voltwo@t.test').post(`/api/v1/shifts/${shiftId}/signup`)).body.error.code).toBe('SHIFT_FULL');
  });

  it('does not allow check-in days before the shift', async () => {
    const res = await h.as('volone@t.test').post(`/api/v1/shifts/${shiftId}/checkin`);
    expect(res.body.error.code).toBe('CHECKIN_NOT_OPEN');
  });

  it('withdrawal more than 24 hours ahead frees the place and emails the coordinator', async () => {
    const sentBefore = h.email.sent.length;
    expect((await h.as('volone@t.test').post(`/api/v1/shifts/${shiftId}/withdraw`)).body.status).toBe('Withdrawn');
    expect(h.email.sent.length).toBe(sentBefore + 1);
    expect(h.email.sent.at(-1)!.to).toBe('coorda@t.test');
    expect((await h.as('voltwo@t.test').post(`/api/v1/shifts/${shiftId}/signup`)).body.status).toBe('Assigned');
  });

  it('refuses self-service withdrawal inside 24 hours', async () => {
    h.setNow(new Date(Date.now() + 4.5 * 86_400_000));
    const res = await h.as('voltwo@t.test').post(`/api/v1/shifts/${shiftId}/withdraw`);
    expect(res.body.error.code).toBe('WITHDRAW_TOO_LATE');
    h.setNow(new Date());
  });

  it('lists my shifts', async () => {
    const res = await h.as('voltwo@t.test').get('/api/v1/shifts/mine');
    expect(res.body.some((s: { id: string; myStatus: string }) => s.id === shiftId && s.myStatus === 'Assigned')).toBe(true);
  });
});
