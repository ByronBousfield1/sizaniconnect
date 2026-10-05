import type pg from 'pg';
import { allocateFefo, type BatchStock } from '../domain/fefo.js';
import { luhnValid } from '../domain/identity.js';
import { parcelSizeFor, type ParcelSize } from '../domain/parcel.js';
import { ROLE_IDS, type Role } from '../domain/roles.js';
import { addDays, saDate, saDateTime } from '../domain/time.js';
import type { Logger } from '../infra/logger.js';
import { hashIdentityNumber } from '../security/tokens.js';
import type { ServiceDeps } from '../services/context.js';
import { withTransaction } from './pool.js';

/**
 * Seeds a realistic, entirely synthetic data set (NFR: no real personal information is used).
 * Runs only against an empty database, so it can safely be left switched on in a demo deployment.
 */
export async function seedDemoData(pool: pg.Pool, deps: ServiceDeps, log: Logger, _opts: { force?: boolean } = {}) {
  const existing = await pool.query('SELECT count(*) AS n FROM users');
  if (existing.rows[0].n > 0) {
    log.info('Seed skipped: database already has users');
    return;
  }
  const password = deps.config.seedDemoPassword ?? (deps.config.isProduction ? undefined : 'Sizani-Demo-2026');
  if (!password) {
    log.warn('Seed skipped: set SEED_DEMO_PASSWORD to seed demo accounts in production');
    return;
  }

  const rand = mulberry32(7315);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const now = deps.clock();
  const today = saDate(now);
  const passwordHash = await deps.hasher.hash(password);

  await withTransaction(pool, async (db) => {
    const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
    const one = async (sql: string, params: unknown[] = []) => (await q(sql, params)).rows[0];

    // ---------------------------------------------------------------- sites
    const siteDefs = [
      ['Diepsloot Extension 2 Hall', 'Diepsloot', 180],
      ['Alexandra 8th Avenue Centre', 'Alexandra', 220],
      ['Orlando East Community Hall', 'Orlando East', 200],
      ['Tembisa Ivory Park Hall', 'Ivory Park', 160],
      ['Orange Farm Extension 7 Centre', 'Orange Farm', 150],
      ['Hillbrow Kotze Street Hall', 'Hillbrow', 120],
    ] as const;
    const sites: { id: string; name: string; suburb: string }[] = [];
    for (const [name, suburb, cap] of siteDefs) {
      const r = await one(
        'INSERT INTO distribution_sites (site_name, suburb, capacity_per_event) VALUES ($1, $2, $3) RETURNING site_id AS id',
        [name, suburb, cap],
      );
      sites.push({ id: r.id, name, suburb });
    }
    const [diepsloot, alexandra, orlando, ivoryPark] = sites;

    // ---------------------------------------------------------------- donors
    const donorDefs = [
      ['Kopano Foods Distribution', 'Corporate', 'donations@kopanofoods.test', false],
      ['The Ndlovu Family Trust', 'Trust', 'trustees@ndlovutrust.test', false],
      ['Lerato Mokoena', 'Individual', 'lerato.m@example.test', false],
      ['Anonymous donor', 'Individual', null, true],
    ] as const;
    const donors: string[] = [];
    for (const [name, type, email, anon] of donorDefs) {
      donors.push((await one('INSERT INTO donors (donor_name, donor_type, contact_email, is_anonymous) VALUES ($1,$2,$3,$4) RETURNING donor_id AS id', [name, type, email, anon])).id);
    }

    // ---------------------------------------------------------------- users
    const userDefs: [string, string, Role, string | null, string | null][] = [
      ['Naledi Khumalo', 'admin@sizani.test', 'Admin', null, null],
      ['Sipho Dlamini', 'ops@sizani.test', 'OperationsManager', null, null],
      ['Thandi Mahlangu', 'coordinator@sizani.test', 'SiteCoordinator', diepsloot.id, null],
      ['Bongani Zulu', 'coordinator.alex@sizani.test', 'SiteCoordinator', alexandra.id, null],
      ['Lindiwe Nkosi', 'volunteer@sizani.test', 'Volunteer', null, null],
      ['Tshepo Molefe', 'volunteer2@sizani.test', 'Volunteer', null, null],
      ['Ayanda Cele', 'volunteer3@sizani.test', 'Volunteer', null, null],
      ['Kopano Foods (portal)', 'donor@sizani.test', 'Donor', null, donors[0]],
    ];
    const users: Record<string, string> = {};
    for (const [name, email, role, siteId, donorId] of userDefs) {
      users[email] = (
        await one(
          `INSERT INTO users (full_name, email, role_id, site_id, donor_id, password_hash, phone_number)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING user_id AS id`,
          [name, email, ROLE_IDS[role], siteId, donorId, passwordHash, `08${Math.floor(rand() * 1e8).toString().padStart(8, '0')}`],
        )
      ).id;
    }
    const ops = users['ops@sizani.test'];
    const coord = users['coordinator@sizani.test'];
    const coordAlex = users['coordinator.alex@sizani.test'];
    const volunteers = [users['volunteer@sizani.test'], users['volunteer2@sizani.test'], users['volunteer3@sizani.test']];

    // ---------------------------------------------------------------- stock catalogue and parcels
    const itemDefs = [
      ['Maize meal 10 kg', 'Staples', 'bag', 60],
      ['Rice 2 kg', 'Staples', 'pack', 60],
      ['Sugar beans 500 g', 'Protein', 'pack', 80],
      ['Pilchards in tomato 400 g', 'Protein', 'tin', 100],
      ['Soya mince 200 g', 'Protein', 'pack', 80],
      ['Sunflower oil 2 L', 'Staples', 'bottle', 40],
      ['Long-life milk 1 L', 'Dairy', 'carton', 80],
      ['Peanut butter 400 g', 'Protein', 'jar', 100],
      ['Rooibos tea 80 bags', 'Other', 'box', 20],
    ] as const;
    const items: Record<string, string> = {};
    for (const [name, cat, uom, reorder] of itemDefs) {
      items[name] = (await one('INSERT INTO stock_items (item_name, category, unit_of_measure, reorder_level) VALUES ($1,$2,$3,$4) RETURNING stock_item_id AS id', [name, cat, uom, reorder])).id;
    }
    const bom: Record<ParcelSize, [string, number][]> = {
      Small: [['Maize meal 10 kg', 1], ['Rice 2 kg', 1], ['Sugar beans 500 g', 1], ['Pilchards in tomato 400 g', 1], ['Long-life milk 1 L', 1]],
      Medium: [['Maize meal 10 kg', 1], ['Rice 2 kg', 1], ['Sugar beans 500 g', 2], ['Pilchards in tomato 400 g', 2], ['Soya mince 200 g', 2], ['Sunflower oil 2 L', 1], ['Long-life milk 1 L', 2], ['Peanut butter 400 g', 1]],
      Large: [['Maize meal 10 kg', 2], ['Rice 2 kg', 2], ['Sugar beans 500 g', 3], ['Pilchards in tomato 400 g', 3], ['Soya mince 200 g', 3], ['Sunflower oil 2 L', 1], ['Long-life milk 1 L', 4], ['Peanut butter 400 g', 1]],
    };
    for (const [size, lines] of Object.entries(bom)) {
      for (const [name, qty] of lines) {
        await q('INSERT INTO parcel_components (parcel_size, stock_item_id, quantity) VALUES ($1,$2,$3)', [size, items[name], qty]);
      }
    }

    // ---------------------------------------------------------------- donations and batches
    let receipt = 0;
    const donation = async (donorIdx: number, type: 'Cash' | 'InKind', value: number, receivedOn: string, notes: string | null) => {
      receipt++;
      await q("SELECT nextval('donation_receipt_seq')");
      return (
        await one(
          `INSERT INTO donations (donor_id, donation_type, monetary_value, received_on, receipt_number, notes, captured_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING donation_id AS id`,
          [donors[donorIdx], type, value, receivedOn, `SZN-R-${receivedOn.slice(0, 4)}-${String(receipt).padStart(6, '0')}`, notes, ops],
        )
      ).id as string;
    };
    const batch = async (itemName: string, donationId: string | null, qty: number, expiry: string | null, receivedOn: string) => {
      const id = (
        await one(
          `INSERT INTO stock_batches (stock_item_id, donation_id, quantity_received, quantity_remaining, expiry_date, received_on)
           VALUES ($1,$2,$3,$3,$4,$5) RETURNING batch_id AS id`,
          [items[itemName], donationId, qty, expiry, receivedOn],
        )
      ).id;
      await q(
        `INSERT INTO stock_movements (batch_id, recorded_by, movement_type, quantity, moved_on) VALUES ($1,$2,'Receipt',$3,$4)`,
        [id, ops, qty, `${receivedOn}T09:00:00+02:00`],
      );
    };

    const d1Date = addDays(today, -62);
    const d1 = await donation(0, 'InKind', 48500, d1Date, 'Quarterly staples consignment');
    await batch('Maize meal 10 kg', d1, 260, addDays(today, 180), d1Date);
    await batch('Rice 2 kg', d1, 240, addDays(today, 300), d1Date);
    await batch('Sugar beans 500 g', d1, 420, addDays(today, 240), d1Date);
    await batch('Sunflower oil 2 L', d1, 160, addDays(today, 200), d1Date);
    await batch('Peanut butter 400 g', d1, 120, addDays(today, 90), d1Date);

    const d2Date = addDays(today, -40);
    const d2 = await donation(1, 'InKind', 22000, d2Date, 'Protein drive');
    await batch('Pilchards in tomato 400 g', d2, 500, addDays(today, 400), d2Date);
    await batch('Soya mince 200 g', d2, 380, addDays(today, 150), d2Date);
    await batch('Long-life milk 1 L', d2, 300, addDays(today, 9), d2Date); // expiring soon: shows in alerts

    const d3Date = addDays(today, -12);
    const d3 = await donation(0, 'InKind', 15800, d3Date, 'Top-up delivery');
    await batch('Long-life milk 1 L', d3, 260, addDays(today, 70), d3Date);
    await batch('Maize meal 10 kg', d3, 120, addDays(today, 210), d3Date);
    await batch('Rooibos tea 80 bags', d3, 40, null, d3Date);

    const d4Date = addDays(today, -95);
    const d4 = await donation(2, 'InKind', 900, d4Date, 'Community collection');
    await batch('Pilchards in tomato 400 g', d4, 24, addDays(today, 30), d4Date);
    await batch('Rooibos tea 80 bags', d4, 12, addDays(today, -3), d4Date); // already expired: needs write-off

    await donation(1, 'Cash', 25000, addDays(today, -55), 'Monthly pledge');
    await donation(2, 'Cash', 1500, addDays(today, -20), null);
    await donation(3, 'Cash', 5000, addDays(today, -6), null);
    await donation(1, 'Cash', 25000, addDays(today, -25), 'Monthly pledge');

    // ---------------------------------------------------------------- households
    const firstNames = ['Thabo', 'Nomsa', 'Sibusiso', 'Zanele', 'Mpho', 'Lerato', 'Kagiso', 'Nandi', 'Themba', 'Palesa',
      'Bheki', 'Dineo', 'Lungile', 'Refilwe', 'Musa', 'Ntombi', 'Karabo', 'Precious', 'Vusi', 'Busisiwe', 'Tumelo', 'Gugu',
      'Mandla', 'Hlengiwe', 'Neo', 'Sizwe', 'Thuli', 'Katlego', 'Ayesha', 'Fatima', 'Chipo', 'Tendai'];
    const surnames = ['Mokoena', 'Nkosi', 'Dlamini', 'Khumalo', 'Ndlovu', 'Sithole', 'Mahlangu', 'Mabaso', 'Molefe', 'Mthembu',
      'Ngcobo', 'Zwane', 'Radebe', 'Shabalala', 'Baloyi', 'Maluleke', 'Mathebula', 'Phiri', 'Moyo', 'Banda'];
    const streets = ['Mandela Street', 'Freedom Road', 'Ubuntu Close', 'Masakhane Street', 'Ntuli Avenue', 'Sisulu Drive', 'Thembeka Crescent'];

    type H = { id: string; siteId: string; members: number; status: string };
    const households: H[] = [];
    const memberPlan = [1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 7];
    const homeSites = [diepsloot, diepsloot, alexandra, alexandra, orlando, ivoryPark];
    for (let i = 0; i < 42; i++) {
      const site = homeSites[i % homeSites.length];
      const surname = pick(surnames);
      const head = `${pick(firstNames)} ${surname}`;
      const size = pick(memberPlan);
      const status = i === 3 || i === 9 || i === 15 ? 'PendingVerification' : i === 21 ? 'Draft' : i === 27 ? 'Suspended' : 'Active';
      const registeredBy = site.id === alexandra.id ? coordAlex : coord;
      const registeredDaysAgo = 20 + Math.floor(rand() * 200);
      const ref = `SZN-${today.slice(0, 4)}-${randomSuffix(rand)}`;
      const h = await one(
        `INSERT INTO households (reference_code, head_of_household, id_number_hash, contact_number, address_line, suburb,
                                 home_site_id, status, status_reason, registered_by, verified_by, registered_on, verified_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() - make_interval(days => $12), CASE WHEN $11::uuid IS NULL THEN NULL ELSE now() - make_interval(days => $12 - 2) END)
         RETURNING household_id AS id`,
        [
          ref,
          head,
          hashIdentityNumber(syntheticSaId(rand), deps.config.idHashPepper),
          `07${Math.floor(rand() * 1e8).toString().padStart(8, '0')}`,
          `${10 + Math.floor(rand() * 4000)} ${pick(streets)}`,
          site.suburb,
          site.id,
          status,
          status === 'Suspended' ? 'Collected at two sites in one cycle; under review' : status === 'Draft' ? 'Proof of address unclear' : null,
          registeredBy,
          status === 'Active' || status === 'Suspended' ? ops : null,
          registeredDaysAgo,
        ],
      );
      const firstName = head.split(' ')[0];
      const members: [string, string, string][] = [[firstName, '18-59', 'Self']];
      for (let m = 1; m < size; m++) {
        const kind = m === 1 && size > 2 ? 'Spouse' : rand() < 0.15 ? 'Elderly' : 'Child';
        const band = kind === 'Spouse' ? '18-59' : kind === 'Elderly' ? '60+' : pick(['0-5', '6-12', '13-17']);
        members.push([pick(firstNames), band, kind]);
      }
      for (const [fn, band, kind] of members) {
        await q('INSERT INTO household_members (household_id, first_name, age_band, dependant_type) VALUES ($1,$2,$3,$4)', [h.id, fn, band, kind]);
      }
      households.push({ id: h.id, siteId: site.id, members: size, status });
    }

    // ---------------------------------------------------------------- past events, rosters and collections
    const components = (await q(
      'SELECT parcel_size AS "parcelSize", stock_item_id AS "stockItemId", quantity FROM parcel_components',
    )).rows as { parcelSize: ParcelSize; stockItemId: string; quantity: number }[];

    const pastEvents: [typeof sites[number], number][] = [
      [diepsloot, -35], [alexandra, -33], [orlando, -30], [ivoryPark, -28],
      [diepsloot, -21], [alexandra, -19], [orlando, -14], [diepsloot, -7], [alexandra, -5],
    ];
    for (const [site, offset] of pastEvents) {
      const date = addDays(today, offset);
      const ev = await one(
        `INSERT INTO distribution_events (site_id, scheduled_date, start_time, end_time, planned_parcels, min_volunteers, status,
                                          physical_count, variance, created_by, opened_at, closed_at, reconciled_at)
         VALUES ($1,$2,'09:00','13:00',$3,2,'Reconciled',$4,0,$5,$6,$7,$7) RETURNING event_id AS id`,
        [site.id, date, 40, 0, ops, saDateTime(date, '09:05'), saDateTime(date, '13:10')],
      );
      const shift = await one(
        'INSERT INTO volunteer_shifts (event_id, starts_at, ends_at, volunteers_needed) VALUES ($1,$2,$3,3) RETURNING shift_id AS id',
        [ev.id, saDateTime(date, '08:30'), saDateTime(date, '13:00')],
      );
      for (const v of volunteers.slice(0, 2 + Math.floor(rand() * 2))) {
        await q(
          `INSERT INTO shift_assignments (shift_id, user_id, status, checked_in_at, hours_served)
           VALUES ($1,$2,'CheckedIn',$3,4.5)`,
          [shift.id, v, saDateTime(date, '08:25')],
        );
      }
      const eligible = households.filter((h) => h.siteId === site.id && h.status === 'Active');
      let count = 0;
      for (const h of eligible) {
        if (rand() < 0.2) continue; // not everyone comes every time
        const size = parcelSizeFor(h.members);
        const at = saDateTime(date, `${String(9 + Math.floor(count / 4)).padStart(2, '0')}:${String((count * 13) % 60).padStart(2, '0')}`);
        const c = await one(
          `INSERT INTO collections (event_id, household_id, verified_by, collected_at, parcel_size)
           VALUES ($1,$2,$3,$4,$5) RETURNING collection_id AS id`,
          [ev.id, h.id, site.id === alexandra.id ? coordAlex : coord, at, size],
        );
        for (const comp of components.filter((x) => x.parcelSize === size)) {
          const batches = (await q(
            `SELECT batch_id AS "batchId", quantity_remaining AS "quantityRemaining", expiry_date AS "expiryDate", received_on AS "receivedOn"
             FROM stock_batches WHERE stock_item_id = $1 AND quantity_remaining > 0 AND received_on <= $2`,
            [comp.stockItemId, date],
          )).rows as BatchStock[];
          const { allocations } = allocateFefo(batches, comp.quantity, date);
          for (const a of allocations) {
            await q('UPDATE stock_batches SET quantity_remaining = quantity_remaining - $2 WHERE batch_id = $1', [a.batchId, a.quantity]);
            await q(
              `INSERT INTO stock_movements (batch_id, event_id, collection_id, recorded_by, movement_type, quantity, moved_on)
               VALUES ($1,$2,$3,$4,'Issue',$5,$6)`,
              [a.batchId, ev.id, c.id, coord, -a.quantity, at],
            );
          }
        }
        await q('UPDATE households SET last_collected_at = GREATEST(COALESCE(last_collected_at, $2), $2) WHERE household_id = $1', [h.id, at]);
        count++;
      }
      await q('UPDATE distribution_events SET physical_count = $2 WHERE event_id = $1', [ev.id, count]);
    }

    // ---------------------------------------------------------------- today and upcoming
    // Today's Diepsloot event is open, with a shift spanning the whole day so check-in works whenever the demo runs.
    const todayEvent = await one(
      `INSERT INTO distribution_events (site_id, scheduled_date, start_time, end_time, planned_parcels, min_volunteers, status, created_by, opened_at)
       VALUES ($1,$2,'08:00','20:00',60,2,'Open',$3,now()) RETURNING event_id AS id`,
      [diepsloot.id, today, ops],
    );
    const todayShift = await one(
      'INSERT INTO volunteer_shifts (event_id, starts_at, ends_at, volunteers_needed, notes) VALUES ($1,$2,$3,4,$4) RETURNING shift_id AS id',
      [todayEvent.id, saDateTime(today, '07:30'), saDateTime(today, '23:30'), 'Queue marshal and collection desk'],
    );
    for (const v of volunteers.slice(1)) {
      await q(`INSERT INTO shift_assignments (shift_id, user_id, status, checked_in_at) VALUES ($1,$2,'CheckedIn',now())`, [todayShift.id, v]);
    }
    await q(`INSERT INTO shift_assignments (shift_id, user_id) VALUES ($1,$2)`, [todayShift.id, volunteers[0]]);

    const upcoming: [typeof sites[number], number, string][] = [
      [alexandra, 2, 'Stocked'], [orlando, 4, 'Planned'], [ivoryPark, 6, 'Planned'], [diepsloot, 9, 'Planned'], [alexandra, 13, 'Planned'],
    ];
    for (const [site, offset, status] of upcoming) {
      const date = addDays(today, offset);
      const ev = await one(
        `INSERT INTO distribution_events (site_id, scheduled_date, start_time, end_time, planned_parcels, min_volunteers, status, created_by)
         VALUES ($1,$2,'09:00','13:00',45,2,$3,$4) RETURNING event_id AS id`,
        [site.id, date, status, ops],
      );
      await q(
        'INSERT INTO volunteer_shifts (event_id, starts_at, ends_at, volunteers_needed, notes) VALUES ($1,$2,$3,$4,$5)',
        [ev.id, saDateTime(date, '08:30'), saDateTime(date, '13:00'), 3, 'Packing and collection desk'],
      );
    }

    await q(
      `INSERT INTO audit_log (user_id, entity_name, action, details) VALUES ($1, 'System', 'SEED', '{"note":"Synthetic demo data"}')`,
      [users['admin@sizani.test']],
    );
  });

  log.info({ accounts: ['admin', 'ops', 'coordinator', 'coordinator.alex', 'volunteer', 'volunteer2', 'volunteer3', 'donor'].map((a) => `${a}@sizani.test`) }, 'Demo data seeded');
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function randomSuffix(rand: () => number) {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(rand() * 32)];
  return s;
}

/** Builds a structurally valid but fictitious SA ID number. */
export function syntheticSaId(rand: () => number): string {
  const yy = String(55 + Math.floor(rand() * 45)).padStart(2, '0');
  const mm = String(1 + Math.floor(rand() * 12)).padStart(2, '0');
  const dd = String(1 + Math.floor(rand() * 28)).padStart(2, '0');
  const seq = String(Math.floor(rand() * 10000)).padStart(4, '0');
  const body = `${yy}${mm}${dd}${seq}08`;
  for (let check = 0; check <= 9; check++) {
    if (luhnValid(body + check)) return body + check;
  }
  throw new Error('unreachable');
}
