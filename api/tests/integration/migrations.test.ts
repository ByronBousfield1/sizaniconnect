import { mkdtemp, readdir, rm, writeFile, copyFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downFileFor, migrate, migrationStatus, MIGRATIONS_DIR, rollback } from '../../src/db/migrate.js';
import { logger } from '../../src/infra/logger.js';
import { createHarness, type Harness } from './harness.js';

/** Everything that defines the schema, as sorted text, so two states can be compared exactly. */
async function schemaSnapshot(pool: pg.Pool): Promise<string[]> {
  const q = async (sql: string) => (await pool.query(sql)).rows.map((r) => Object.values(r).join('|'));
  return [
    ...(await q(`SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default,'') FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name NOT LIKE '_backup%' ORDER BY 1, 2`)),
    ...(await q(`SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint
                 WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`)),
    ...(await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`)),
    ...(await q(`SELECT event_object_table, trigger_name, action_timing, event_manipulation FROM information_schema.triggers
                 WHERE trigger_schema = 'public' ORDER BY 1, 2, 4`)),
  ].sort();
}

const rowCounts = async (pool: pg.Pool) =>
  (await pool.query(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM households) AS households,
                            (SELECT count(*) FROM collections) AS collections`)).rows[0];

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.activeHousehold();
});
afterAll(() => h.close());

describe('migration rollback rehearsal (runs in CI before every deploy)', () => {
  it('every migration after the first has a down script', async () => {
    const status = await migrationStatus(h.pool);
    for (const m of status.slice(1)) expect(m.hasDownScript, `${m.version} needs migrations/down/${downFileFor(m.version)}`).toBe(true);
  });

  it('rolling each migration back and forward again leaves the schema exactly as it was and keeps the data', async () => {
    const before = await schemaSnapshot(h.pool);
    const countsBefore = await rowCounts(h.pool);
    const versions = (await migrationStatus(h.pool)).map((m) => m.version);

    // Newest first: undo one migration at a time, then re-apply everything.
    for (let i = versions.length - 1; i >= 1; i--) {
      const undone = await rollback(h.pool, logger, versions[i - 1]);
      expect(undone).toEqual([versions[i]]);
      const applied = (await migrationStatus(h.pool)).filter((m) => m.applied).map((m) => m.version);
      expect(applied).not.toContain(versions[i]);
    }
    expect(await migrate(h.pool, logger)).toEqual(versions.slice(1));

    expect(await schemaSnapshot(h.pool)).toEqual(before);
    expect(await rowCounts(h.pool)).toEqual(countsBefore);
  });

  it('only rolls back to an applied migration, so the initial schema can never be dropped', async () => {
    await expect(rollback(h.pool, logger, 'not-a-migration.sql')).rejects.toThrow(/not an applied migration/);
  });
});

describe('a migration that fails part-way', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'szn-migrations-'));
    await mkdir(path.join(dir, 'down'));
    for (const f of (await readdir(MIGRATIONS_DIR)).filter((x) => x.endsWith('.sql'))) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    for (const f of await readdir(path.join(MIGRATIONS_DIR, 'down'))) await copyFile(path.join(MIGRATIONS_DIR, 'down', f), path.join(dir, 'down', f));
    // Creates a table, then hits an error: nothing of it may survive.
    await writeFile(path.join(dir, '900_broken.sql'), 'CREATE TABLE half_done (id int); SELECT 1 / 0;');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('is rolled back completely and is not recorded as applied', async () => {
    await expect(migrate(h.pool, logger, dir)).rejects.toThrow(/900_broken\.sql failed and was rolled back/);
    const t = await h.pool.query(`SELECT to_regclass('public.half_done') AS t`);
    expect(t.rows[0].t).toBeNull();
    const s = await migrationStatus(h.pool, dir);
    expect(s.find((m) => m.version === '900_broken.sql')?.applied).toBe(false);
  });

  it('a rollback with a missing down script changes nothing', async () => {
    await writeFile(path.join(dir, '900_broken.sql'), 'CREATE TABLE fine_now (id int);');
    await migrate(h.pool, logger, dir);
    const versions = (await migrationStatus(h.pool, dir)).map((m) => m.version);
    const previous = versions[versions.length - 2];
    await expect(rollback(h.pool, logger, previous, dir)).rejects.toThrow(/No down script for 900_broken\.sql/);
    expect((await h.pool.query(`SELECT to_regclass('public.fine_now') AS t`)).rows[0].t).not.toBeNull();
    // Tidy up so later test files start from the real migration set.
    await h.pool.query(`DROP TABLE fine_now; DELETE FROM schema_migrations WHERE version = '900_broken.sql'`);
  });
});
