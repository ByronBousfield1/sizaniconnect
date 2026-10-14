import request from 'supertest';
import { loadConfig, type Config } from '../../src/config.js';
import { buildContainer } from '../../src/container.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { syntheticSaId } from '../../src/db/seed.js';
import { ROLE_IDS, type Role } from '../../src/domain/roles.js';
import { addDays, saDate } from '../../src/domain/time.js';
import { createApp } from '../../src/http/app.js';
import { MemoryEmailSender } from '../../src/infra/email.js';
import { logger } from '../../src/infra/logger.js';

export const PASSWORD = 'Correct-Horse-Battery-9';
export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://sizani:sizani@localhost:5432/sizani_test';

let idSeed = 99;
const rand = () => ((idSeed = (idSeed * 16807) % 2147483647) / 2147483647);
export const newSaId = () => syntheticSaId(rand);

/**
 * Builds a fresh database and app for one test file: real PostgreSQL, real migrations, real HTTP
 * pipeline. Only the clock and the mail sender are substituted.
 */
export async function createHarness(configOverrides: Partial<Config> = {}) {
  const pool = createPool(TEST_DB, false);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool, logger);

  const config = loadConfig({
    databaseUrl: TEST_DB,
    pbkdf2Iterations: 1000,
    authRateLimitPerMinute: 1000,
    appBaseUrl: 'http://localhost:5173',
    ...configOverrides,
  });
  let now = new Date();
  const email = new MemoryEmailSender();
  const { deps, services } = buildContainer(config, pool, logger, { email, clock: () => now });
  const app = createApp({ config, services, tokens: deps.tokens, pool, log: logger });
  const hash = await deps.hasher.hash(PASSWORD);
  const today = saDate(now);

  const one = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0];

  // ---- sites, donors, users
  const siteA = (await one(`INSERT INTO distribution_sites (site_name, suburb, capacity_per_event) VALUES ('Site A','Diepsloot',100) RETURNING site_id AS id`, [])).id as string;
  const siteB = (await one(`INSERT INTO distribution_sites (site_name, suburb, capacity_per_event) VALUES ('Site B','Alexandra',100) RETURNING site_id AS id`, [])).id as string;
  const donor1 = (await one(`INSERT INTO donors (donor_name, donor_type, contact_email) VALUES ('Donor One','Corporate','d1@example.test') RETURNING donor_id AS id`, [])).id as string;
  const donor2 = (await one(`INSERT INTO donors (donor_name, donor_type) VALUES ('Donor Two','Individual') RETURNING donor_id AS id`, [])).id as string;

  const user = async (email: string, role: Role, siteId: string | null = null, donorId: string | null = null) =>
    (await one(
      'INSERT INTO users (full_name, email, role_id, site_id, donor_id, password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING user_id AS id',
      [email.split('@')[0].replace(/[^a-z]/gi, ' '), email, ROLE_IDS[role], siteId, donorId, hash],
    )).id as string;

  const users = {
    admin: await user('admin@t.test', 'Admin'),
    ops: await user('ops@t.test', 'OperationsManager'),
    ops2: await user('opstwo@t.test', 'OperationsManager'),
    coordA: await user('coorda@t.test', 'SiteCoordinator', siteA),
    coordB: await user('coordb@t.test', 'SiteCoordinator', siteB),
    vol1: await user('volone@t.test', 'Volunteer'),
    vol2: await user('voltwo@t.test', 'Volunteer'),
    donor: await user('donor@t.test', 'Donor', null, donor1),
  };

  // ---- stock: maize has an early batch, a late batch and an expired batch; beans has one batch
  const maize = (await one(`INSERT INTO stock_items (item_name, category, unit_of_measure, reorder_level) VALUES ('Maize','Staples','bag',5) RETURNING stock_item_id AS id`, [])).id as string;
  const beans = (await one(`INSERT INTO stock_items (item_name, category, unit_of_measure, reorder_level) VALUES ('Beans','Protein','pack',500) RETURNING stock_item_id AS id`, [])).id as string;
  for (const [size, m, b] of [['Small', 1, 1], ['Medium', 1, 2], ['Large', 2, 3]] as const) {
    await pool.query('INSERT INTO parcel_components VALUES ($1,$2,$3),($1,$4,$5)', [size, maize, m, beans, b]);
  }
  const batch = async (item: string, qty: number, expiry: string | null, donationId: string | null = null) =>
    (await one(
      `INSERT INTO stock_batches (stock_item_id, donation_id, quantity_received, quantity_remaining, expiry_date, received_on)
       VALUES ($1,$2,$3,$3,$4,$5) RETURNING batch_id AS id`,
      [item, donationId, qty, expiry, addDays(today, -30)],
    )).id as string;
  const donation1 = (await one(
    `INSERT INTO donations (donor_id, donation_type, monetary_value, received_on, receipt_number, captured_by)
     VALUES ($1,'InKind',0,$2,'SZN-R-TEST-1',$3) RETURNING donation_id AS id`,
    [donor1, addDays(today, -30), users.ops],
  )).id as string;
  const batches = {
    maizeEarly: await batch(maize, 10, addDays(today, 10), donation1),
    maizeLate: await batch(maize, 100, addDays(today, 200)),
    maizeExpired: await batch(maize, 50, addDays(today, -1)),
    beans: await batch(beans, 200, addDays(today, 90), donation1),
  };

  const tokens = new Map<string, string>();
  async function login(emailAddr: string): Promise<string> {
    if (!tokens.has(emailAddr)) {
      const res = await request(app).post('/api/v1/auth/login').send({ email: emailAddr, password: PASSWORD });
      if (res.status !== 200) throw new Error(`login failed for ${emailAddr}: ${res.status} ${JSON.stringify(res.body)}`);
      tokens.set(emailAddr, res.body.accessToken);
    }
    return tokens.get(emailAddr)!;
  }

  const as = (emailAddr: string) => {
    const withAuth = async (method: 'get' | 'post' | 'patch', url: string, body?: unknown) => {
      const t = await login(emailAddr);
      const req = request(app)[method](url).set('Authorization', `Bearer ${t}`);
      return body === undefined ? req : req.send(body as object);
    };
    return {
      get: (url: string) => withAuth('get', url),
      post: (url: string, body: unknown = {}) => withAuth('post', url, body),
      patch: (url: string, body: unknown) => withAuth('patch', url, body),
    };
  };

  /** Registers a household as coordinator A and has a second manager verify it. */
  async function activeHousehold(members = 4, site = siteA) {
    const coordEmail = site === siteA ? 'coorda@t.test' : 'coordb@t.test';
    const kids = Array.from({ length: members - 1 }, (_, i) => ({ firstName: `Child ${String.fromCharCode(65 + i)}`, ageBand: '6-12', dependantType: 'Child' }));
    const reg = await as(coordEmail).post('/api/v1/households', {
      headOfHousehold: 'Nomsa Dlamini',
      idNumber: newSaId(),
      contactNumber: '082 555 0134',
      addressLine: '12 Freedom Road',
      suburb: 'Diepsloot',
      homeSiteId: site,
      members: [{ firstName: 'Nomsa', ageBand: '18-59', dependantType: 'Self' }, ...kids],
    });
    if (reg.status !== 201) throw new Error(`register failed ${reg.status} ${JSON.stringify(reg.body)}`);
    const v = await as('ops@t.test').post(`/api/v1/households/${reg.body.id}/verify`);
    if (v.status !== 200) throw new Error(`verify failed ${v.status} ${JSON.stringify(v.body)}`);
    return reg.body as { id: string; referenceCode: string };
  }

  /** An event at site A, already open, with two checked-in volunteers. */
  async function openEvent(site = siteA) {
    const ev = await one(
      `INSERT INTO distribution_events (site_id, scheduled_date, start_time, end_time, planned_parcels, min_volunteers, status, created_by, opened_at)
       VALUES ($1,$2,'00:00','23:59',20,0,'Open',$3,now()) RETURNING event_id AS id`,
      [site, today, users.ops],
    );
    return ev.id as string;
  }

  return {
    app,
    pool,
    deps,
    email,
    today,
    sites: { A: siteA, B: siteB },
    donors: { d1: donor1, d2: donor2 },
    users,
    items: { maize, beans },
    batches,
    donation1,
    setNow: (d: Date) => {
      now = d;
    },
    login,
    as,
    activeHousehold,
    openEvent,
    remaining: async (batchId: string) =>
      (await one('SELECT quantity_remaining AS q FROM stock_batches WHERE batch_id = $1', [batchId])).q as number,
    auditCount: async (entity: string, action: string) =>
      (await one('SELECT count(*) AS n FROM audit_log WHERE entity_name = $1 AND action = $2', [entity, action])).n as number,
    close: () => pool.end(),
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
