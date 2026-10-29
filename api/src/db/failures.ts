/**
 * Infrastructure failures, as opposed to mistakes in a request (Task 2 feedback: capture failure
 * states such as "database connection lost" and "storage full", and how the system recovers).
 *
 * Each is answered with 503 and a Retry-After header, and a message that says whether anything was
 * saved and what to do. Every write runs in one transaction (NFR-06), so a failure part-way leaves
 * nothing half-saved. The pool replaces broken connections by itself: no restart is needed once the
 * database is back.
 */
export interface DatabaseFailure {
  code: 'DATABASE_UNAVAILABLE' | 'STORAGE_FULL' | 'DATABASE_BUSY' | 'DATABASE_TIMEOUT';
  message: string;
  retryAfterSeconds: number;
  /** Storage full needs a person to act; the others usually clear by themselves. */
  severity: 'error' | 'fatal';
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'EPIPE',
  '08000', '08001', '08003', '08004', '08006', // connection_exception family
  '57P01', '57P02', '57P03', // admin_shutdown, crash_shutdown, cannot_connect_now (restart or failover)
]);
const CONNECTION_MESSAGES = /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|connect ETIMEDOUT/i;

export function classifyDatabaseFailure(err: unknown): DatabaseFailure | null {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return null;
  const code = e.code ?? '';
  if (code === '53100' || code === '25006') {
    // 53100 disk_full. 25006 read_only_sql_transaction: Azure switches the server to read-only when
    // storage passes 95%, so reading still works and every write is refused.
    return {
      code: 'STORAGE_FULL',
      message:
        'The database is out of storage space, so nothing can be saved at the moment. What you can see is still correct. Tell your administrator; this does not fix itself.',
      retryAfterSeconds: 300,
      severity: 'fatal',
    };
  }
  if (code === '53300' || code === '53200') {
    return { code: 'DATABASE_BUSY', message: 'The system is very busy. Nothing was saved. Wait a few seconds and try again.', retryAfterSeconds: 5, severity: 'error' };
  }
  if (code === '57014') {
    return { code: 'DATABASE_TIMEOUT', message: 'The database took too long to answer, so nothing was saved. Try again.', retryAfterSeconds: 5, severity: 'error' };
  }
  if (CONNECTION_CODES.has(code) || CONNECTION_MESSAGES.test(e.message ?? '')) {
    return {
      code: 'DATABASE_UNAVAILABLE',
      message: 'The system cannot reach its database right now, so nothing was saved. Try again in a minute.',
      retryAfterSeconds: 30,
      severity: 'error',
    };
  }
  return null;
}
