import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import type { Logger } from '../infra/logger.js';

const LOCK_KEY = 7315;
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', '..', 'migrations');

/** migrations/002_cellphone_numbers.sql is undone by migrations/down/002_cellphone_numbers.down.sql */
export const downFileFor = (version: string) => version.replace(/\.sql$/, '.down.sql');

async function upFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
}

async function withLock<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    return await fn(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

async function appliedVersions(client: pg.PoolClient): Promise<string[]> {
  return (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
}

/**
 * Applies pending .sql migrations in filename order, each in its own transaction. If one fails,
 * its transaction rolls back, nothing after it runs, and the app refuses to start, so a half-applied
 * schema can never serve traffic. An advisory lock means two app instances starting together cannot
 * both migrate. Running at startup keeps the database closed to the build pipeline.
 */
export async function migrate(pool: pg.Pool, log: Logger, dir = MIGRATIONS_DIR): Promise<string[]> {
  return withLock(pool, async (client) => {
    const done = new Set(await appliedVersions(client));
    const applied: string[] = [];
    for (const file of await upFiles(dir)) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log.info({ migration: file }, 'Migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed and was rolled back: ${(err as Error).message}`, { cause: err });
      }
    }
    return applied;
  });
}

/**
 * Undoes applied migrations, newest first, until `target` is the latest one applied. Each step runs
 * its down script and removes its schema_migrations row in one transaction. Rolling back the very
 * first migration is refused: that would drop every table, which is a restore, not a rollback.
 */
export async function rollback(pool: pg.Pool, log: Logger, target: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  return withLock(pool, async (client) => {
    const applied = await appliedVersions(client);
    if (!applied.includes(target)) throw new Error(`${target} is not an applied migration. Applied: ${applied.join(', ')}`);
    const toUndo = applied.filter((v) => v > target).reverse();

    // Check every down script exists before touching anything.
    for (const version of toUndo) {
      if (!existsSync(path.join(dir, 'down', downFileFor(version)))) {
        throw new Error(`No down script for ${version} (expected migrations/down/${downFileFor(version)}). Nothing was changed.`);
      }
    }

    const undone: string[] = [];
    for (const version of toUndo) {
      const sql = await readFile(path.join(dir, 'down', downFileFor(version)), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
        await client.query('COMMIT');
        undone.push(version);
        log.warn({ migration: version }, 'Migration rolled back');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Rolling back ${version} failed; it is still applied: ${(err as Error).message}`, { cause: err });
      }
    }
    return undone;
  });
}

export interface MigrationStatus {
  version: string;
  applied: boolean;
  appliedAt: Date | null;
  hasDownScript: boolean;
}

export async function migrationStatus(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<MigrationStatus[]> {
  return withLock(pool, async (client) => {
    const rows = (await client.query('SELECT version, applied_at FROM schema_migrations')).rows as { version: string; applied_at: Date }[];
    const at = new Map(rows.map((r) => [r.version, r.applied_at]));
    return (await upFiles(dir)).map((version) => ({
      version,
      applied: at.has(version),
      appliedAt: at.get(version) ?? null,
      hasDownScript: existsSync(path.join(dir, 'down', downFileFor(version))),
    }));
  });
}
