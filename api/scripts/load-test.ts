/**
 * Load test for the performance requirements (NFR-01 to NFR-03, NFR-05).
 *
 *   1. Tops a seeded database up to 5,000 households with six months of collection history.
 *   2. Drives the running API with concurrent requests, the way a busy distribution day would.
 *   3. Prints the 50th and 95th percentile response times against each requirement as Markdown.
 *
 * Usage (API already running against LOAD_DATABASE_URL, with the general rate limit raised because
 * all requests come from one machine):
 *   LOAD_DATABASE_URL=postgresql://... LOAD_BASE_URL=http://localhost:8080 npx tsx scripts/load-test.ts
 *
 * It refuses to run against a database whose name does not contain "perf".
 */
import pg from 'pg';

const BASE = process.env.LOAD_BASE_URL ?? 'http://localhost:8080';
const DB = process.env.LOAD_DATABASE_URL ?? 'postgresql://sizani:sizani@localhost:5432/sizani_perf';
const PASSWORD = process.env.LOAD_PASSWORD ?? 'Sizani-Demo-2026';
const TARGET_HOUSEHOLDS = 5_000;
if (!/perf/.test(new URL(DB).pathname)) throw new Error('Use a database whose name contains "perf".');

const pool = new pg.Pool({ connectionString: DB });
const log = (s: string) => process.stdout.write(`${s}\n`);

// --------------------------------------------------------------------------------- data
async function topUp() {
  const { n } = (await pool.query('SELECT count(*)::int AS n FROM households')).rows[0];
  if (n >= TARGET_HOUSEHOLDS) return log(`Already ${n} households.`);
  log(`Adding ${TARGET_HOUSEHOLDS - n} households and six months of history...`);
  await pool.query(
    `WITH sites AS (SELECT array_agg(site_id ORDER BY site_name) AS ids, array_agg(suburb ORDER BY site_name) AS suburbs FROM distribution_sites),
          staff AS (SELECT user_id FROM users WHERE role_id = 2 ORDER BY email LIMIT 1),
          src AS (
            SELECT g, 1 + (g % 6) AS k,
                   'SZN-' || (2023 + g % 4) || '-' ||
                   (SELECT string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1), '') FROM generate_series(1, 6) WHERE g > 0) AS code
            FROM generate_series(1, $1::int) g)
     INSERT INTO households (reference_code, head_of_household, id_number_hash, contact_number, address_line, suburb, home_site_id,
                             status, registered_by, verified_by, registered_on, verified_on)
     SELECT DISTINCT ON (code) code,
            (ARRAY['Nomsa','Thabo','Lerato','Sipho','Zanele','Musa','Precious','Bongani','Ayanda','Kagiso'])[1 + g % 10] || ' ' ||
            (ARRAY['Dlamini','Nkosi','Mokoena','Khumalo','Ndlovu','Mahlangu','Sithole','Zulu','Mthembu','Molefe','Dube','Khoza'])[1 + (g / 10) % 12],
            encode(sha256(('perf-' || g)::bytea), 'hex'),
            '+2782' || lpad((g % 10000000)::text, 7, '0'),
            (10 + g % 4000) || ' Freedom Road', sites.suburbs[k], sites.ids[k], 'Active',
            staff.user_id, staff.user_id, now() - make_interval(days => 30 + g % 300), now() - make_interval(days => 28 + g % 300)
     FROM src, sites, staff
     ON CONFLICT (reference_code) DO NOTHING`,
    [TARGET_HOUSEHOLDS - n + 50],
  );
  await pool.query(
    `INSERT INTO household_members (household_id, first_name, age_band, dependant_type)
     SELECT h.household_id, split_part(h.head_of_household, ' ', 1), '18-59', 'Self'
     FROM households h WHERE NOT EXISTS (SELECT 1 FROM household_members m WHERE m.household_id = h.household_id)`,
  );
  await pool.query(
    `INSERT INTO household_members (household_id, first_name, age_band, dependant_type)
     SELECT h.household_id, 'Child', (ARRAY['0-5','6-12','13-17'])[1 + (abs(hashtext(h.reference_code)) % 3)], 'Child'
     FROM households h, generate_series(1, 1 + abs(hashtext(h.reference_code)) % 4)
     WHERE h.address_line LIKE '% Freedom Road'
       AND (SELECT count(*) FROM household_members m WHERE m.household_id = h.household_id) = 1`,
  );
  // Six months of reconciled distribution days: one a week per site, about 120 households each.
  await pool.query(
    `INSERT INTO distribution_events (site_id, scheduled_date, start_time, end_time, planned_parcels, status, created_by, opened_at, closed_at, reconciled_at)
     SELECT s.site_id, (current_date - 7 * w)::date, '09:00', '13:00', 150, 'Reconciled',
            (SELECT user_id FROM users WHERE role_id = 2 ORDER BY email LIMIT 1), now(), now(), now()
     FROM distribution_sites s, generate_series(2, 27) w`,
  );
  await pool.query(
    `INSERT INTO collections (event_id, household_id, verified_by, collected_at, parcel_size)
     SELECT e.event_id, h.household_id, (SELECT user_id FROM users WHERE role_id = 3 ORDER BY email LIMIT 1),
            e.scheduled_date + time '10:00', 'Medium'
     FROM distribution_events e
     CROSS JOIN LATERAL (SELECT household_id FROM households WHERE home_site_id = e.site_id AND status = 'Active'
                         ORDER BY md5(household_id::text || e.event_id::text) LIMIT 120) h
     WHERE e.status = 'Reconciled' AND NOT EXISTS (SELECT 1 FROM collections c WHERE c.event_id = e.event_id)`,
  );
  // Enough stock that the collection test measures speed, not shortages.
  await pool.query(
    `INSERT INTO stock_batches (stock_item_id, quantity_received, quantity_remaining, expiry_date, received_on)
     SELECT stock_item_id, 5000, 5000, current_date + 180, current_date FROM stock_items`,
  );
  await pool.query('ANALYZE');
  const c = (await pool.query(`SELECT (SELECT count(*) FROM households)::int AS h, (SELECT count(*) FROM collections)::int AS c`)).rows[0];
  log(`Now ${c.h} households and ${c.c} collections.`);
}

// --------------------------------------------------------------------------------- client
async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

interface Sample {
  ms: number;
  ok: boolean;
}

async function run(count: number, concurrency: number, fn: (i: number) => Promise<Response>): Promise<Sample[]> {
  const samples: Sample[] = [];
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const i = next++;
      const t = performance.now();
      let ok = false;
      try {
        const res = await fn(i);
        await res.arrayBuffer();
        ok = res.ok;
      } catch {
        ok = false;
      }
      samples.push({ ms: performance.now() - t, ok });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return samples;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

// --------------------------------------------------------------------------------- scenarios
async function main() {
  await topUp();
  const coord = await login('coordinator@sizani.test');
  const ops = await login('ops@sizani.test');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const open = (await pool.query(
    `SELECT e.event_id AS id, e.site_id AS "siteId" FROM distribution_events e JOIN distribution_sites s ON s.site_id = e.site_id
     WHERE e.status = 'Open' AND s.site_name = 'Diepsloot Extension 2 Hall' LIMIT 1`,
  )).rows[0];
  const eligible = (await pool.query(
    `SELECT household_id AS id, reference_code AS code FROM households h
     WHERE status = 'Active' AND home_site_id = $1
       AND NOT EXISTS (SELECT 1 FROM collections c WHERE c.event_id = $2 AND c.household_id = h.household_id)
     ORDER BY reference_code LIMIT 400`,
    [open.siteId, open.id],
  )).rows as { id: string; code: string }[];
  const surnames = ['Dlamini', 'Nkosi', 'Mokoena', 'Khumalo', 'Ndlovu', 'Mahlangu', 'Sithole', 'Zulu', 'Mthembu', 'Molefe', 'Dube', 'Kho'];
  const month = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 7);
  const results: { id: string; what: string; target: number; samples: Sample[]; concurrency: number }[] = [];

  log('Warming up...');
  await run(30, 5, (i) => fetch(`${BASE}/api/v1/households?q=${surnames[i % 12]}`, { headers: auth(coord) }));

  log('NFR-01 household search...');
  results.push({
    id: 'NFR-01', what: 'Household search by name (5,000 households)', target: 2000, concurrency: 25,
    samples: await run(1000, 25, (i) => fetch(`${BASE}/api/v1/households?q=${surnames[i % 12]}&page=${1 + (i % 3)}`, { headers: auth(coord) })),
  });
  log('Desk lookup by reference code...');
  results.push({
    id: 'NFR-01', what: 'Event desk lookup by reference code', target: 2000, concurrency: 25,
    samples: await run(1000, 25, (i) => fetch(`${BASE}/api/v1/households/by-ref/${eligible[i % eligible.length].code}?eventId=${open.id}`, { headers: auth(coord) })),
  });
  log('NFR-02 record collection...');
  results.push({
    id: 'NFR-02', what: 'Record a collection, including FEFO stock deduction', target: 1500, concurrency: 10,
    samples: await run(Math.min(300, eligible.length), 10, (i) =>
      fetch(`${BASE}/api/v1/collections`, {
        method: 'POST',
        headers: { ...auth(coord), 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: open.id, householdId: eligible[i].id }),
      }),
    ),
  });
  log('NFR-03 monthly report...');
  results.push({
    id: 'NFR-03', what: `Monthly report on screen (${month})`, target: 8000, concurrency: 2,
    samples: await run(20, 2, () => fetch(`${BASE}/api/v1/reports/monthly?month=${month}`, { headers: auth(ops) })),
  });
  results.push({
    id: 'NFR-03', what: `Monthly report CSV export (${month})`, target: 20000, concurrency: 2,
    samples: await run(20, 2, () => fetch(`${BASE}/api/v1/reports/monthly.csv?month=${month}`, { headers: auth(ops) })),
  });

  const counts = (await pool.query(`SELECT (SELECT count(*) FROM households)::int AS h, (SELECT count(*) FROM collections)::int AS c`)).rows[0];
  log('');
  log(`| Requirement | Operation | Requests | Concurrent | Errors | p50 | p95 | Target (p95) | Result |`);
  log(`| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);
  for (const r of results) {
    const ms = r.samples.map((s) => s.ms);
    const errors = r.samples.filter((s) => !s.ok).length;
    const p95 = pct(ms, 95);
    log(
      `| ${r.id} | ${r.what} | ${r.samples.length} | ${r.concurrency} | ${errors} | ${pct(ms, 50).toFixed(0)} ms | ${p95.toFixed(0)} ms | ${(r.target / 1000).toFixed(1)} s | ${
        errors === 0 && p95 < r.target ? 'Met' : 'Not met'
      } |`,
    );
  }
  log('');
  log(`Data: ${counts.h} households, ${counts.c} collections.`);
  await pool.end();
}

await main();
