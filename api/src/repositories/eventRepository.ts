import type { Db } from '../db/pool.js';
import type { EventStatus } from '../domain/distributionEvent.js';

export interface SiteRecord {
  id: string;
  siteName: string;
  suburb: string;
  capacityPerEvent: number;
  isActive: boolean;
}

export interface EventRecord {
  id: string;
  siteId: string;
  siteName: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  plannedParcels: number;
  minVolunteers: number;
  status: EventStatus;
  physicalCount: number | null;
  variance: number | null;
  varianceReason: string | null;
  cancelReason: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
  reconciledAt: Date | null;
  collectionCount: number;
  checkedInVolunteers: number;
}

const SELECT_SITE = `
  SELECT site_id AS id, site_name AS "siteName", suburb, capacity_per_event AS "capacityPerEvent", is_active AS "isActive"
  FROM distribution_sites`;

const SELECT_EVENT = `
  SELECT e.event_id AS id, e.site_id AS "siteId", s.site_name AS "siteName", e.scheduled_date AS "scheduledDate",
         to_char(e.start_time, 'HH24:MI') AS "startTime", to_char(e.end_time, 'HH24:MI') AS "endTime",
         e.planned_parcels AS "plannedParcels", e.min_volunteers AS "minVolunteers", e.status,
         e.physical_count AS "physicalCount", e.variance, e.variance_reason AS "varianceReason",
         e.cancel_reason AS "cancelReason", e.opened_at AS "openedAt", e.closed_at AS "closedAt",
         e.reconciled_at AS "reconciledAt",
         (SELECT count(*) FROM collections c WHERE c.event_id = e.event_id) AS "collectionCount",
         (SELECT count(*) FROM shift_assignments a JOIN volunteer_shifts vs ON vs.shift_id = a.shift_id
           WHERE vs.event_id = e.event_id AND a.status = 'CheckedIn') AS "checkedInVolunteers"
  FROM distribution_events e
  JOIN distribution_sites s ON s.site_id = e.site_id`;

export class EventRepository {
  constructor(private readonly db: Db) {}

  // ---- sites -------------------------------------------------------------------------------

  async listSites(includeInactive = true): Promise<SiteRecord[]> {
    const r = await this.db.query(SELECT_SITE + ' WHERE ($1 OR is_active) ORDER BY site_name', [includeInactive]);
    return r.rows;
  }

  async findSite(id: string): Promise<SiteRecord | null> {
    const r = await this.db.query(SELECT_SITE + ' WHERE site_id = $1', [id]);
    return r.rows[0] ?? null;
  }

  async insertSite(s: { siteName: string; suburb: string; capacityPerEvent: number }): Promise<string> {
    const r = await this.db.query(
      'INSERT INTO distribution_sites (site_name, suburb, capacity_per_event) VALUES ($1, $2, $3) RETURNING site_id AS id',
      [s.siteName, s.suburb, s.capacityPerEvent],
    );
    return r.rows[0].id;
  }

  async updateSite(id: string, p: { siteName?: string; suburb?: string; capacityPerEvent?: number; isActive?: boolean }) {
    await this.db.query(
      `UPDATE distribution_sites SET site_name = COALESCE($2, site_name), suburb = COALESCE($3, suburb),
              capacity_per_event = COALESCE($4, capacity_per_event), is_active = COALESCE($5, is_active)
       WHERE site_id = $1`,
      [id, p.siteName ?? null, p.suburb ?? null, p.capacityPerEvent ?? null, p.isActive ?? null],
    );
  }

  // ---- events ------------------------------------------------------------------------------

  async insertEvent(e: {
    siteId: string;
    scheduledDate: string;
    startTime: string;
    endTime: string;
    plannedParcels: number;
    minVolunteers: number;
    createdBy: string;
  }): Promise<string> {
    const r = await this.db.query(
      `INSERT INTO distribution_events (site_id, scheduled_date, start_time, end_time, planned_parcels, min_volunteers, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING event_id AS id`,
      [e.siteId, e.scheduledDate, e.startTime, e.endTime, e.plannedParcels, e.minVolunteers, e.createdBy],
    );
    return r.rows[0].id;
  }

  async findEvent(id: string, forUpdate = false): Promise<EventRecord | null> {
    const r = await this.db.query(SELECT_EVENT + ' WHERE e.event_id = $1' + (forUpdate ? ' FOR UPDATE OF e' : ''), [id]);
    return r.rows[0] ?? null;
  }

  async listEvents(f: { from?: string; to?: string; siteId?: string; status?: EventStatus }): Promise<EventRecord[]> {
    const r = await this.db.query(
      SELECT_EVENT +
        ` WHERE ($1::date IS NULL OR e.scheduled_date >= $1)
            AND ($2::date IS NULL OR e.scheduled_date <= $2)
            AND ($3::uuid IS NULL OR e.site_id = $3)
            AND ($4::text IS NULL OR e.status = $4)
          ORDER BY e.scheduled_date, e.start_time, s.site_name
          LIMIT 200`,
      [f.from ?? null, f.to ?? null, f.siteId ?? null, f.status ?? null],
    );
    return r.rows;
  }

  async setStatus(
    id: string,
    status: EventStatus,
    extra: { physicalCount?: number; variance?: number; varianceReason?: string | null; cancelReason?: string } = {},
  ): Promise<void> {
    await this.db.query(
      `UPDATE distribution_events SET
         status          = $2::text,
         opened_at       = CASE WHEN $2::text = 'Open' THEN now() ELSE opened_at END,
         closed_at       = CASE WHEN $2::text = 'Closed' THEN now() ELSE closed_at END,
         reconciled_at   = CASE WHEN $2::text = 'Reconciled' THEN now() ELSE reconciled_at END,
         physical_count  = COALESCE($3, physical_count),
         variance        = COALESCE($4, variance),
         variance_reason = COALESCE($5, variance_reason),
         cancel_reason   = COALESCE($6, cancel_reason)
       WHERE event_id = $1`,
      [id, status, extra.physicalCount ?? null, extra.variance ?? null, extra.varianceReason ?? null, extra.cancelReason ?? null],
    );
  }

  async householdsServed(eventId: string): Promise<number> {
    const r = await this.db.query('SELECT count(DISTINCT household_id) AS n FROM collections WHERE event_id = $1', [eventId]);
    return r.rows[0].n;
  }
}
