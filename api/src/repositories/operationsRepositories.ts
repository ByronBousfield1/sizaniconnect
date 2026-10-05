import type { Db } from '../db/pool.js';
import type { BatchStock } from '../domain/fefo.js';
import type { ParcelSize } from '../domain/parcel.js';

// ============================================================================ collections

export class CollectionRepository {
  constructor(private readonly db: Db) {}

  async findStandard(eventId: string, householdId: string) {
    const r = await this.db.query(
      `SELECT c.collection_id AS id, c.collected_at AS "collectedAt", u.full_name AS "verifiedByName"
       FROM collections c JOIN users u ON u.user_id = c.verified_by
       WHERE c.event_id = $1 AND c.household_id = $2 AND NOT c.is_override`,
      [eventId, householdId],
    );
    return (r.rows[0] as { id: string; collectedAt: Date; verifiedByName: string } | undefined) ?? null;
  }

  async insert(c: {
    eventId: string;
    householdId: string;
    verifiedBy: string;
    parcelSize: ParcelSize;
    isOverride: boolean;
    overrideReason: string | null;
  }): Promise<{ id: string; collectedAt: Date }> {
    const r = await this.db.query(
      `INSERT INTO collections (event_id, household_id, verified_by, parcel_size, is_override, override_reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING collection_id AS id, collected_at AS "collectedAt"`,
      [c.eventId, c.householdId, c.verifiedBy, c.parcelSize, c.isOverride, c.overrideReason],
    );
    return r.rows[0];
  }

  async listForEvent(eventId: string) {
    const r = await this.db.query(
      `SELECT c.collection_id AS id, c.collected_at AS "collectedAt", c.parcel_size AS "parcelSize",
              c.is_override AS "isOverride", c.override_reason AS "overrideReason",
              h.household_id AS "householdId", h.reference_code AS "referenceCode",
              h.head_of_household AS "headOfHousehold", u.full_name AS "verifiedByName"
       FROM collections c
       JOIN households h ON h.household_id = c.household_id
       JOIN users u ON u.user_id = c.verified_by
       WHERE c.event_id = $1 ORDER BY c.collected_at DESC`,
      [eventId],
    );
    return r.rows;
  }
}

// ============================================================================ shifts

export interface ShiftRecord {
  id: string;
  eventId: string;
  siteId: string;
  siteName: string;
  eventDate: string;
  eventStatus: string;
  startsAt: Date;
  endsAt: Date;
  volunteersNeeded: number;
  filled: number;
  notes: string | null;
  myStatus: string | null;
}

const SELECT_SHIFT = `
  SELECT vs.shift_id AS id, vs.event_id AS "eventId", e.site_id AS "siteId", s.site_name AS "siteName",
         e.scheduled_date AS "eventDate", e.status AS "eventStatus", vs.starts_at AS "startsAt", vs.ends_at AS "endsAt",
         vs.volunteers_needed AS "volunteersNeeded", vs.notes,
         (SELECT count(*) FROM shift_assignments a WHERE a.shift_id = vs.shift_id AND a.status <> 'Withdrawn') AS filled,
         (SELECT a.status FROM shift_assignments a WHERE a.shift_id = vs.shift_id AND a.user_id = $1) AS "myStatus"
  FROM volunteer_shifts vs
  JOIN distribution_events e ON e.event_id = vs.event_id
  JOIN distribution_sites s ON s.site_id = e.site_id`;

export class ShiftRepository {
  constructor(private readonly db: Db) {}

  async insert(s: { eventId: string; startsAt: Date; endsAt: Date; volunteersNeeded: number; notes: string | null }) {
    const r = await this.db.query(
      `INSERT INTO volunteer_shifts (event_id, starts_at, ends_at, volunteers_needed, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING shift_id AS id`,
      [s.eventId, s.startsAt, s.endsAt, s.volunteersNeeded, s.notes],
    );
    return r.rows[0].id as string;
  }

  async find(shiftId: string, viewerId: string, forUpdate = false): Promise<ShiftRecord | null> {
    const r = await this.db.query(
      SELECT_SHIFT + ' WHERE vs.shift_id = $2' + (forUpdate ? ' FOR UPDATE OF vs' : ''),
      [viewerId, shiftId],
    );
    return r.rows[0] ?? null;
  }

  async list(viewerId: string, f: { from: Date; to: Date; siteId?: string; eventId?: string }): Promise<ShiftRecord[]> {
    const r = await this.db.query(
      SELECT_SHIFT +
        ` WHERE vs.ends_at >= $2 AND vs.starts_at <= $3
            AND e.status NOT IN ('Cancelled','Reconciled')
            AND ($4::uuid IS NULL OR e.site_id = $4)
            AND ($5::uuid IS NULL OR e.event_id = $5)
          ORDER BY vs.starts_at, s.site_name`,
      [viewerId, f.from, f.to, f.siteId ?? null, f.eventId ?? null],
    );
    return r.rows;
  }

  async listMine(userId: string): Promise<ShiftRecord[]> {
    const r = await this.db.query(
      SELECT_SHIFT +
        ` WHERE EXISTS (SELECT 1 FROM shift_assignments a WHERE a.shift_id = vs.shift_id AND a.user_id = $1)
            AND vs.ends_at >= now() - interval '30 days'
          ORDER BY vs.starts_at DESC`,
      [userId],
    );
    return r.rows;
  }

  async findAssignment(shiftId: string, userId: string) {
    const r = await this.db.query(
      'SELECT assignment_id AS id, status FROM shift_assignments WHERE shift_id = $1 AND user_id = $2 FOR UPDATE',
      [shiftId, userId],
    );
    return (r.rows[0] as { id: string; status: string } | undefined) ?? null;
  }

  async assign(shiftId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO shift_assignments (shift_id, user_id) VALUES ($1, $2)
       ON CONFLICT (shift_id, user_id)
       DO UPDATE SET status = 'Assigned', assigned_at = now(), withdrawn_at = NULL`,
      [shiftId, userId],
    );
  }

  async setAssignmentStatus(id: string, status: 'Withdrawn' | 'CheckedIn'): Promise<void> {
    await this.db.query(
      `UPDATE shift_assignments SET status = $2::text,
              withdrawn_at = CASE WHEN $2::text = 'Withdrawn' THEN now() ELSE withdrawn_at END,
              checked_in_at = CASE WHEN $2::text = 'CheckedIn' THEN now() ELSE checked_in_at END
       WHERE assignment_id = $1`,
      [id, status],
    );
  }

  /** Hours served = overlap of the shift with the time the volunteer was actually present. */
  async recordHoursForEvent(eventId: string): Promise<void> {
    await this.db.query(
      `UPDATE shift_assignments a SET hours_served = round(GREATEST(0, EXTRACT(EPOCH FROM (
                LEAST(vs.ends_at, now()) - GREATEST(vs.starts_at, a.checked_in_at)
              )) / 3600)::numeric, 2)
       FROM volunteer_shifts vs
       WHERE vs.shift_id = a.shift_id AND vs.event_id = $1 AND a.status = 'CheckedIn'`,
      [eventId],
    );
  }

  async rosterForEvent(eventId: string) {
    const r = await this.db.query(
      `SELECT vs.shift_id AS "shiftId", vs.starts_at AS "startsAt", vs.ends_at AS "endsAt", u.full_name AS "volunteerName",
              a.status, a.checked_in_at AS "checkedInAt", a.hours_served AS "hoursServed"
       FROM volunteer_shifts vs
       JOIN shift_assignments a ON a.shift_id = vs.shift_id AND a.status <> 'Withdrawn'
       JOIN users u ON u.user_id = a.user_id
       WHERE vs.event_id = $1 ORDER BY vs.starts_at, u.full_name`,
      [eventId],
    );
    return r.rows;
  }
}

// ============================================================================ donors & donations

export class DonationRepository {
  constructor(private readonly db: Db) {}

  async listDonors() {
    const r = await this.db.query(
      `SELECT d.donor_id AS id, d.donor_name AS "donorName", d.donor_type AS "donorType",
              d.contact_email AS "contactEmail", d.is_anonymous AS "isAnonymous",
              COALESCE(sum(dn.monetary_value), 0) AS "totalValue", count(dn.donation_id) AS "donationCount"
       FROM donors d LEFT JOIN donations dn ON dn.donor_id = d.donor_id
       GROUP BY d.donor_id ORDER BY d.donor_name`,
    );
    return r.rows;
  }

  async findDonor(id: string) {
    const r = await this.db.query(
      `SELECT donor_id AS id, donor_name AS "donorName", donor_type AS "donorType", contact_email AS "contactEmail",
              is_anonymous AS "isAnonymous" FROM donors WHERE donor_id = $1`,
      [id],
    );
    return (r.rows[0] as
      | { id: string; donorName: string; donorType: string; contactEmail: string | null; isAnonymous: boolean }
      | undefined) ?? null;
  }

  async insertDonor(d: { donorName: string; donorType: string; contactEmail: string | null; isAnonymous: boolean }) {
    const r = await this.db.query(
      `INSERT INTO donors (donor_name, donor_type, contact_email, is_anonymous) VALUES ($1, $2, $3, $4)
       RETURNING donor_id AS id`,
      [d.donorName, d.donorType, d.contactEmail, d.isAnonymous],
    );
    return r.rows[0].id as string;
  }

  async nextReceiptNumber(year: number): Promise<string> {
    const r = await this.db.query("SELECT nextval('donation_receipt_seq') AS n");
    return `SZN-R-${year}-${String(r.rows[0].n).padStart(6, '0')}`;
  }

  async insert(d: {
    donorId: string;
    donationType: 'Cash' | 'InKind';
    monetaryValue: number;
    receivedOn: string;
    receiptNumber: string;
    notes: string | null;
    capturedBy: string;
  }) {
    const r = await this.db.query(
      `INSERT INTO donations (donor_id, donation_type, monetary_value, received_on, receipt_number, notes, captured_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING donation_id AS id`,
      [d.donorId, d.donationType, d.monetaryValue, d.receivedOn, d.receiptNumber, d.notes, d.capturedBy],
    );
    return r.rows[0].id as string;
  }

  async list(f: { donorId?: string; limit: number }) {
    const r = await this.db.query(
      `SELECT dn.donation_id AS id, dn.donation_type AS "donationType", dn.monetary_value AS "monetaryValue",
              dn.received_on AS "receivedOn", dn.receipt_number AS "receiptNumber", dn.notes,
              d.donor_id AS "donorId", d.donor_name AS "donorName",
              (SELECT count(*) FROM stock_batches b WHERE b.donation_id = dn.donation_id) AS "lineCount"
       FROM donations dn JOIN donors d ON d.donor_id = dn.donor_id
       WHERE ($1::uuid IS NULL OR dn.donor_id = $1)
       ORDER BY dn.received_on DESC, dn.created_at DESC LIMIT $2`,
      [f.donorId ?? null, f.limit],
    );
    return r.rows;
  }

  async find(id: string) {
    const r = await this.db.query(
      `SELECT dn.donation_id AS id, dn.donation_type AS "donationType", dn.monetary_value AS "monetaryValue",
              dn.received_on AS "receivedOn", dn.receipt_number AS "receiptNumber", dn.notes,
              d.donor_id AS "donorId", d.donor_name AS "donorName", d.donor_type AS "donorType",
              d.contact_email AS "contactEmail", u.full_name AS "capturedByName"
       FROM donations dn JOIN donors d ON d.donor_id = dn.donor_id JOIN users u ON u.user_id = dn.captured_by
       WHERE dn.donation_id = $1`,
      [id],
    );
    if (!r.rows[0]) return null;
    const lines = await this.db.query(
      `SELECT b.batch_id AS "batchId", i.item_name AS "itemName", i.unit_of_measure AS "unitOfMeasure",
              b.quantity_received AS quantity, b.quantity_remaining AS "quantityRemaining", b.expiry_date AS "expiryDate"
       FROM stock_batches b JOIN stock_items i ON i.stock_item_id = b.stock_item_id
       WHERE b.donation_id = $1 ORDER BY i.item_name`,
      [id],
    );
    return { ...r.rows[0], lines: lines.rows };
  }
}

// ============================================================================ stock

export class StockRepository {
  constructor(private readonly db: Db) {}

  /** On-hand counts only stock that can still be issued today (unexpired). */
  async listItems(today: string) {
    const r = await this.db.query(
      `SELECT i.stock_item_id AS id, i.item_name AS "itemName", i.category, i.unit_of_measure AS "unitOfMeasure",
              i.reorder_level AS "reorderLevel",
              COALESCE(sum(b.quantity_remaining) FILTER (WHERE b.expiry_date IS NULL OR b.expiry_date >= $1), 0) AS "onHand",
              COALESCE(sum(b.quantity_remaining) FILTER (WHERE b.expiry_date < $1), 0) AS "expiredOnHand",
              min(b.expiry_date) FILTER (WHERE b.quantity_remaining > 0 AND b.expiry_date >= $1) AS "nextExpiry"
       FROM stock_items i LEFT JOIN stock_batches b ON b.stock_item_id = i.stock_item_id AND b.quantity_remaining > 0
       GROUP BY i.stock_item_id ORDER BY i.category, i.item_name`,
      [today],
    );
    return r.rows as {
      id: string;
      itemName: string;
      category: string;
      unitOfMeasure: string;
      reorderLevel: number;
      onHand: number;
      expiredOnHand: number;
      nextExpiry: string | null;
    }[];
  }

  async findItem(id: string) {
    const r = await this.db.query(
      `SELECT stock_item_id AS id, item_name AS "itemName", unit_of_measure AS "unitOfMeasure" FROM stock_items
       WHERE stock_item_id = $1`,
      [id],
    );
    return (r.rows[0] as { id: string; itemName: string; unitOfMeasure: string } | undefined) ?? null;
  }

  async insertItem(i: { itemName: string; category: string; unitOfMeasure: string; reorderLevel: number }) {
    const r = await this.db.query(
      `INSERT INTO stock_items (item_name, category, unit_of_measure, reorder_level) VALUES ($1, $2, $3, $4)
       RETURNING stock_item_id AS id`,
      [i.itemName, i.category, i.unitOfMeasure, i.reorderLevel],
    );
    return r.rows[0].id as string;
  }

  async batchesForItem(itemId: string) {
    const r = await this.db.query(
      `SELECT b.batch_id AS id, b.quantity_received AS "quantityReceived", b.quantity_remaining AS "quantityRemaining",
              b.expiry_date AS "expiryDate", b.received_on AS "receivedOn", d.receipt_number AS "receiptNumber",
              dn.donor_name AS "donorName"
       FROM stock_batches b
       LEFT JOIN donations d ON d.donation_id = b.donation_id
       LEFT JOIN donors dn ON dn.donor_id = d.donor_id
       WHERE b.stock_item_id = $1 ORDER BY (b.quantity_remaining = 0), b.expiry_date NULLS LAST, b.received_on`,
      [itemId],
    );
    return r.rows;
  }

  /** Locks the batches FEFO will draw from, so two concurrent issues cannot take the same stock. */
  async lockBatchesForIssue(itemId: string): Promise<BatchStock[]> {
    const r = await this.db.query(
      `SELECT batch_id AS "batchId", quantity_remaining AS "quantityRemaining", expiry_date AS "expiryDate",
              received_on AS "receivedOn"
       FROM stock_batches WHERE stock_item_id = $1 AND quantity_remaining > 0
       ORDER BY expiry_date NULLS LAST, received_on FOR UPDATE`,
      [itemId],
    );
    return r.rows;
  }

  async insertBatch(b: { stockItemId: string; donationId: string | null; quantity: number; expiryDate: string | null; receivedOn: string }) {
    const r = await this.db.query(
      `INSERT INTO stock_batches (stock_item_id, donation_id, quantity_received, quantity_remaining, expiry_date, received_on)
       VALUES ($1, $2, $3, $3, $4, $5) RETURNING batch_id AS id`,
      [b.stockItemId, b.donationId, b.quantity, b.expiryDate, b.receivedOn],
    );
    return r.rows[0].id as string;
  }

  async decrementBatch(batchId: string, quantity: number): Promise<void> {
    await this.db.query('UPDATE stock_batches SET quantity_remaining = quantity_remaining - $2 WHERE batch_id = $1', [
      batchId,
      quantity,
    ]);
  }

  async findBatch(batchId: string) {
    const r = await this.db.query(
      `SELECT b.batch_id AS id, b.quantity_remaining AS "quantityRemaining", b.expiry_date AS "expiryDate",
              i.item_name AS "itemName"
       FROM stock_batches b JOIN stock_items i ON i.stock_item_id = b.stock_item_id
       WHERE b.batch_id = $1 FOR UPDATE OF b`,
      [batchId],
    );
    return (r.rows[0] as { id: string; quantityRemaining: number; expiryDate: string | null; itemName: string } | undefined) ?? null;
  }

  async insertMovement(m: {
    batchId: string;
    eventId?: string | null;
    collectionId?: string | null;
    recordedBy: string;
    movementType: 'Receipt' | 'Issue' | 'WriteOff' | 'Adjustment';
    quantity: number;
    reason?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO stock_movements (batch_id, event_id, collection_id, recorded_by, movement_type, quantity, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [m.batchId, m.eventId ?? null, m.collectionId ?? null, m.recordedBy, m.movementType, m.quantity, m.reason ?? null],
    );
  }

  async parcelComponents(size?: ParcelSize) {
    const r = await this.db.query(
      `SELECT p.parcel_size AS "parcelSize", p.stock_item_id AS "stockItemId", i.item_name AS "itemName",
              i.unit_of_measure AS "unitOfMeasure", p.quantity
       FROM parcel_components p JOIN stock_items i ON i.stock_item_id = p.stock_item_id
       WHERE ($1::text IS NULL OR p.parcel_size = $1)
       ORDER BY CASE p.parcel_size WHEN 'Small' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, i.item_name`,
      [size ?? null],
    );
    return r.rows as { parcelSize: ParcelSize; stockItemId: string; itemName: string; unitOfMeasure: string; quantity: number }[];
  }

  /** Quantity issuable on a given date (batches not expired by then). */
  async availableOn(itemId: string, date: string): Promise<number> {
    const r = await this.db.query(
      `SELECT COALESCE(sum(quantity_remaining), 0) AS n FROM stock_batches
       WHERE stock_item_id = $1 AND (expiry_date IS NULL OR expiry_date >= $2)`,
      [itemId, date],
    );
    return r.rows[0].n;
  }

  async expiringBatches(today: string, horizon: string) {
    const r = await this.db.query(
      `SELECT b.batch_id AS "batchId", i.stock_item_id AS "stockItemId", i.item_name AS "itemName",
              i.unit_of_measure AS "unitOfMeasure", b.quantity_remaining AS "quantityRemaining", b.expiry_date AS "expiryDate",
              (b.expiry_date < $1) AS expired
       FROM stock_batches b JOIN stock_items i ON i.stock_item_id = b.stock_item_id
       WHERE b.quantity_remaining > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= $2
       ORDER BY b.expiry_date`,
      [today, horizon],
    );
    return r.rows;
  }
}

// ============================================================================ audit

export interface AuditEntry {
  userId: string | null;
  entityName: string;
  entityId: string | null;
  action: string;
  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export class AuditRepository {
  constructor(private readonly db: Db) {}

  async write(e: AuditEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log (user_id, entity_name, entity_id, action, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.userId, e.entityName, e.entityId, e.action, e.details ? JSON.stringify(e.details) : null, e.ipAddress ?? null],
    );
  }

  async list(f: { entityName?: string; userId?: string; from?: string; to?: string; limit: number; offset: number }) {
    const params = [f.entityName ?? null, f.userId ?? null, f.from ?? null, f.to ?? null];
    const where = `
      WHERE ($1::text IS NULL OR a.entity_name = $1)
        AND ($2::uuid IS NULL OR a.user_id = $2)
        AND ($3::date IS NULL OR a.occurred_at >= $3::date)
        AND ($4::date IS NULL OR a.occurred_at < ($4::date + 1))`;
    const [rows, total] = await Promise.all([
      this.db.query(
        `SELECT a.audit_id AS id, a.occurred_at AS "occurredAt", a.entity_name AS "entityName", a.entity_id AS "entityId",
                a.action, a.details, a.ip_address AS "ipAddress", u.full_name AS "userName", u.email AS "userEmail"
         FROM audit_log a LEFT JOIN users u ON u.user_id = a.user_id` +
          where +
          ' ORDER BY a.occurred_at DESC, a.audit_id DESC LIMIT $5 OFFSET $6',
        [...params, f.limit, f.offset],
      ),
      this.db.query('SELECT count(*) AS n FROM audit_log a' + where, params),
    ]);
    return { items: rows.rows, total: total.rows[0].n as number };
  }
}

// ============================================================================ reporting

export class ReportRepository {
  constructor(private readonly db: Db) {}

  async monthlyBySite(start: string, end: string) {
    const r = await this.db.query(
      `SELECT s.site_id AS "siteId", s.site_name AS "siteName",
              (SELECT count(*) FROM distribution_events e
                WHERE e.site_id = s.site_id AND e.scheduled_date >= $1 AND e.scheduled_date < $2
                  AND e.status IN ('Open','Closed','Reconciled')) AS "eventsHeld",
              (SELECT count(DISTINCT c.household_id) FROM collections c JOIN distribution_events e ON e.event_id = c.event_id
                WHERE e.site_id = s.site_id AND e.scheduled_date >= $1 AND e.scheduled_date < $2) AS "householdsServed",
              (SELECT count(*) FROM collections c JOIN distribution_events e ON e.event_id = c.event_id
                WHERE e.site_id = s.site_id AND e.scheduled_date >= $1 AND e.scheduled_date < $2) AS "parcelsIssued",
              (SELECT count(*) FROM collections c JOIN distribution_events e ON e.event_id = c.event_id
                WHERE e.site_id = s.site_id AND e.scheduled_date >= $1 AND e.scheduled_date < $2 AND c.is_override) AS overrides,
              (SELECT COALESCE(sum(a.hours_served), 0) FROM shift_assignments a
                 JOIN volunteer_shifts vs ON vs.shift_id = a.shift_id
                 JOIN distribution_events e ON e.event_id = vs.event_id
                WHERE e.site_id = s.site_id AND e.scheduled_date >= $1 AND e.scheduled_date < $2) AS "volunteerHours"
       FROM distribution_sites s ORDER BY s.site_name`,
      [start, end],
    );
    return r.rows as {
      siteId: string;
      siteName: string;
      eventsHeld: number;
      householdsServed: number;
      parcelsIssued: number;
      overrides: number;
      volunteerHours: number;
    }[];
  }

  async donationsInRange(start: string, end: string) {
    const r = await this.db.query(
      `SELECT COALESCE(sum(monetary_value) FILTER (WHERE donation_type = 'Cash'), 0) AS "cashTotal",
              count(*) FILTER (WHERE donation_type = 'InKind') AS "inKindCount",
              count(*) AS "donationCount"
       FROM donations WHERE received_on >= $1 AND received_on < $2`,
      [start, end],
    );
    return r.rows[0] as { cashTotal: number; inKindCount: number; donationCount: number };
  }

  async distinctHouseholdsInRange(start: string, end: string): Promise<number> {
    const r = await this.db.query(
      `SELECT count(DISTINCT c.household_id) AS n FROM collections c JOIN distribution_events e ON e.event_id = c.event_id
       WHERE e.scheduled_date >= $1 AND e.scheduled_date < $2`,
      [start, end],
    );
    return r.rows[0].n;
  }

  /** Traces a donor's stock through issue movements to the parcels and households it reached. */
  async donorImpact(donorId: string) {
    const totals = await this.db.query(
      `SELECT COALESCE(sum(monetary_value) FILTER (WHERE donation_type = 'Cash'), 0) AS "cashGiven",
              count(*) AS "donationCount", min(received_on) AS "firstGift"
       FROM donations WHERE donor_id = $1`,
      [donorId],
    );
    const reach = await this.db.query(
      `SELECT count(DISTINCT m.collection_id) AS "parcelsContributedTo",
              count(DISTINCT c.household_id) AS "householdsReached",
              count(DISTINCT e.site_id) AS "sitesReached"
       FROM stock_movements m
       JOIN stock_batches b ON b.batch_id = m.batch_id
       JOIN donations d ON d.donation_id = b.donation_id
       JOIN collections c ON c.collection_id = m.collection_id
       JOIN distribution_events e ON e.event_id = c.event_id
       WHERE d.donor_id = $1 AND m.movement_type = 'Issue'`,
      [donorId],
    );
    const items = await this.db.query(
      `SELECT i.item_name AS "itemName", i.unit_of_measure AS "unitOfMeasure",
              sum(b.quantity_received) AS received,
              sum(b.quantity_received - b.quantity_remaining) AS distributed
       FROM stock_batches b JOIN donations d ON d.donation_id = b.donation_id
       JOIN stock_items i ON i.stock_item_id = b.stock_item_id
       WHERE d.donor_id = $1 GROUP BY i.item_name, i.unit_of_measure ORDER BY i.item_name`,
      [donorId],
    );
    return { ...totals.rows[0], ...reach.rows[0], items: items.rows };
  }

  async upcomingEvents(today: string, siteId: string | null, limit = 5) {
    const r = await this.db.query(
      `SELECT e.event_id AS id, s.site_name AS "siteName", e.scheduled_date AS "scheduledDate",
              to_char(e.start_time, 'HH24:MI') AS "startTime", to_char(e.end_time, 'HH24:MI') AS "endTime",
              e.status, e.planned_parcels AS "plannedParcels",
              (SELECT count(*) FROM collections c WHERE c.event_id = e.event_id) AS "collectionCount"
       FROM distribution_events e JOIN distribution_sites s ON s.site_id = e.site_id
       WHERE e.scheduled_date >= $1 AND e.status NOT IN ('Cancelled','Reconciled')
         AND ($2::uuid IS NULL OR e.site_id = $2)
       ORDER BY e.scheduled_date, e.start_time LIMIT $3`,
      [today, siteId, limit],
    );
    return r.rows;
  }

  async unfilledShiftCount(fromTs: Date, toTs: Date): Promise<number> {
    const r = await this.db.query(
      `SELECT count(*) AS n FROM volunteer_shifts vs JOIN distribution_events e ON e.event_id = vs.event_id
       WHERE vs.starts_at BETWEEN $1 AND $2 AND e.status NOT IN ('Cancelled','Reconciled')
         AND vs.volunteers_needed > (SELECT count(*) FROM shift_assignments a
                                     WHERE a.shift_id = vs.shift_id AND a.status <> 'Withdrawn')`,
      [fromTs, toTs],
    );
    return r.rows[0].n;
  }
}
