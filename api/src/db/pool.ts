import pg from 'pg';

// Return counts and numeric(…) columns as numbers, and SQL dates as plain yyyy-mm-dd strings so no
// timezone shift can move a distribution day.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, ssl: boolean): pg.Pool {
  return new pg.Pool({
    connectionString,
    // NFR-13: Azure Database for PostgreSQL only accepts TLS, and the certificate is verified.
    ssl: ssl ? { rejectUnauthorized: true } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

/** Unit of Work boundary: everything inside `fn` commits together or not at all (NFR-06). */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}
