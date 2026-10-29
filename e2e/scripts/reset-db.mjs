// Empties the end-to-end database so the server migrates and seeds it from scratch on start.
import pg from '../../api/node_modules/pg/lib/index.js';

const url = process.env.DATABASE_URL;
if (!url || !/e2e/.test(url)) throw new Error(`Refusing to reset ${url}: the database name must contain "e2e".`);
const admin = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, '/postgres') });
await admin.connect();
const name = new URL(url).pathname.slice(1);
const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount;
if (!exists) await admin.query(`CREATE DATABASE "${name}"`);
await admin.end();
const db = new pg.Client({ connectionString: url });
await db.connect();
await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await db.end();
