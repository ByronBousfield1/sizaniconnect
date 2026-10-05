import type { Db } from '../db/pool.js';
import type { HouseholdStatus } from '../domain/household.js';

export interface MemberInput {
  firstName: string;
  ageBand: string;
  dependantType: string;
}

export interface HouseholdRecord {
  id: string;
  referenceCode: string;
  headOfHousehold: string;
  contactNumber: string | null;
  addressLine: string;
  suburb: string;
  homeSiteId: string;
  homeSiteName: string;
  status: HouseholdStatus;
  statusReason: string | null;
  registeredBy: string;
  registeredByName: string;
  verifiedBy: string | null;
  verifiedByName: string | null;
  registeredOn: Date;
  verifiedOn: Date | null;
  lastCollectedAt: Date | null;
  memberCount: number;
}

const SELECT_HOUSEHOLD = `
  SELECT h.household_id AS id, h.reference_code AS "referenceCode", h.head_of_household AS "headOfHousehold",
         h.contact_number AS "contactNumber", h.address_line AS "addressLine", h.suburb,
         h.home_site_id AS "homeSiteId", s.site_name AS "homeSiteName", h.status, h.status_reason AS "statusReason",
         h.registered_by AS "registeredBy", ru.full_name AS "registeredByName",
         h.verified_by AS "verifiedBy", vu.full_name AS "verifiedByName",
         h.registered_on AS "registeredOn", h.verified_on AS "verifiedOn", h.last_collected_at AS "lastCollectedAt",
         (SELECT count(*) FROM household_members m WHERE m.household_id = h.household_id) AS "memberCount"
  FROM households h
  JOIN distribution_sites s ON s.site_id = h.home_site_id
  JOIN users ru ON ru.user_id = h.registered_by
  LEFT JOIN users vu ON vu.user_id = h.verified_by`;

/** Escapes LIKE wildcards so a search for "50%" means the literal text. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export class HouseholdRepository {
  constructor(private readonly db: Db) {}

  async findLiveByIdHash(hash: string): Promise<{ id: string; referenceCode: string; homeSiteName: string } | null> {
    const r = await this.db.query(
      `SELECT h.household_id AS id, h.reference_code AS "referenceCode", s.site_name AS "homeSiteName"
       FROM households h JOIN distribution_sites s ON s.site_id = h.home_site_id
       WHERE h.id_number_hash = $1 AND h.status <> 'Archived'`,
      [hash],
    );
    return r.rows[0] ?? null;
  }

  async referenceExists(code: string): Promise<boolean> {
    const r = await this.db.query('SELECT 1 FROM households WHERE reference_code = $1', [code]);
    return r.rowCount! > 0;
  }

  async insert(h: {
    referenceCode: string;
    headOfHousehold: string;
    idNumberHash: string;
    contactNumber: string | null;
    addressLine: string;
    suburb: string;
    homeSiteId: string;
    registeredBy: string;
  }): Promise<string> {
    const r = await this.db.query(
      `INSERT INTO households (reference_code, head_of_household, id_number_hash, contact_number, address_line,
                               suburb, home_site_id, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING household_id AS id`,
      [h.referenceCode, h.headOfHousehold, h.idNumberHash, h.contactNumber, h.addressLine, h.suburb, h.homeSiteId, h.registeredBy],
    );
    return r.rows[0].id;
  }

  async insertMembers(householdId: string, members: MemberInput[]): Promise<void> {
    for (const m of members) {
      await this.db.query(
        'INSERT INTO household_members (household_id, first_name, age_band, dependant_type) VALUES ($1, $2, $3, $4)',
        [householdId, m.firstName, m.ageBand, m.dependantType],
      );
    }
  }

  async replaceMembers(householdId: string, members: MemberInput[]): Promise<void> {
    await this.db.query('DELETE FROM household_members WHERE household_id = $1', [householdId]);
    await this.insertMembers(householdId, members);
  }

  async findById(id: string, forUpdate = false): Promise<HouseholdRecord | null> {
    const r = await this.db.query(
      SELECT_HOUSEHOLD + ' WHERE h.household_id = $1' + (forUpdate ? ' FOR UPDATE OF h' : ''),
      [id],
    );
    return r.rows[0] ?? null;
  }

  async findByReference(code: string): Promise<HouseholdRecord | null> {
    const r = await this.db.query(SELECT_HOUSEHOLD + ' WHERE h.reference_code = $1', [code]);
    return r.rows[0] ?? null;
  }

  async members(householdId: string) {
    const r = await this.db.query(
      `SELECT member_id AS id, first_name AS "firstName", age_band AS "ageBand", dependant_type AS "dependantType"
       FROM household_members WHERE household_id = $1
       ORDER BY CASE dependant_type WHEN 'Self' THEN 0 WHEN 'Spouse' THEN 1 ELSE 2 END, first_name`,
      [householdId],
    );
    return r.rows as { id: string; firstName: string; ageBand: string; dependantType: string }[];
  }

  async memberCount(householdId: string): Promise<number> {
    const r = await this.db.query('SELECT count(*) AS n FROM household_members WHERE household_id = $1', [householdId]);
    return r.rows[0].n;
  }

  async search(f: { q?: string; status?: HouseholdStatus; siteId?: string; limit: number; offset: number }) {
    const q = f.q ? likeEscape(f.q.trim()) : null;
    const params = [q, f.status ?? null, f.siteId ?? null];
    const where = `
      WHERE ($1::text IS NULL OR h.reference_code ILIKE '%' || $1 || '%'
                              OR h.head_of_household ILIKE '%' || $1 || '%'
                              OR h.suburb ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR h.status = $2)
        AND ($3::uuid IS NULL OR h.home_site_id = $3)`;
    const [rows, total] = await Promise.all([
      this.db.query(
        SELECT_HOUSEHOLD + where + ' ORDER BY h.registered_on DESC LIMIT $4 OFFSET $5',
        [...params, f.limit, f.offset],
      ),
      this.db.query('SELECT count(*) AS n FROM households h' + where, params),
    ]);
    return { items: rows.rows as HouseholdRecord[], total: total.rows[0].n as number };
  }

  async updateStatus(id: string, status: HouseholdStatus, reason: string | null, verifiedBy?: string): Promise<void> {
    await this.db.query(
      `UPDATE households SET status = $2, status_reason = $3, updated_at = now(),
              verified_by = COALESCE($4, verified_by),
              verified_on = CASE WHEN $4::uuid IS NOT NULL THEN now() ELSE verified_on END
       WHERE household_id = $1`,
      [id, status, reason, verifiedBy ?? null],
    );
  }

  async updateDetails(
    id: string,
    patch: { headOfHousehold?: string; contactNumber?: string | null; addressLine?: string; suburb?: string },
  ): Promise<void> {
    await this.db.query(
      `UPDATE households SET
         head_of_household = COALESCE($2, head_of_household),
         contact_number    = CASE WHEN $3::boolean THEN $4 ELSE contact_number END,
         address_line      = COALESCE($5, address_line),
         suburb            = COALESCE($6, suburb),
         updated_at        = now()
       WHERE household_id = $1`,
      [
        id,
        patch.headOfHousehold ?? null,
        patch.contactNumber !== undefined,
        patch.contactNumber ?? null,
        patch.addressLine ?? null,
        patch.suburb ?? null,
      ],
    );
  }

  async setLastCollected(id: string, at: string): Promise<void> {
    await this.db.query(
      'UPDATE households SET last_collected_at = GREATEST(COALESCE(last_collected_at, $2), $2) WHERE household_id = $1',
      [id, at],
    );
  }

  /** BR-08: households with no collection (or registration) in 12 months are archived. */
  async archiveInactive(): Promise<string[]> {
    const r = await this.db.query(
      `UPDATE households SET status = 'Archived', status_reason = 'No collection in 12 months', updated_at = now()
       WHERE status IN ('Active','Suspended')
         AND COALESCE(last_collected_at, registered_on) < now() - interval '12 months'
       RETURNING household_id AS id`,
    );
    return r.rows.map((row) => row.id);
  }

  async recentCollections(householdId: string, limit = 10) {
    const r = await this.db.query(
      `SELECT c.collection_id AS id, c.collected_at AS "collectedAt", c.parcel_size AS "parcelSize",
              c.is_override AS "isOverride", s.site_name AS "siteName", e.scheduled_date AS "eventDate"
       FROM collections c
       JOIN distribution_events e ON e.event_id = c.event_id
       JOIN distribution_sites s ON s.site_id = e.site_id
       WHERE c.household_id = $1 ORDER BY c.collected_at DESC LIMIT $2`,
      [householdId, limit],
    );
    return r.rows;
  }

  async statusCounts(siteId?: string | null): Promise<Record<string, number>> {
    const r = await this.db.query(
      'SELECT status, count(*) AS n FROM households WHERE ($1::uuid IS NULL OR home_site_id = $1) GROUP BY status',
      [siteId ?? null],
    );
    return Object.fromEntries(r.rows.map((row) => [row.status, row.n]));
  }
}
