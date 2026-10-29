/**
 * Thin fetch wrapper. The access token lives only in memory (never localStorage, so an XSS payload
 * has nothing persistent to steal); the refresh token is an HttpOnly cookie the browser handles.
 */
let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let onSessionLost: () => void = () => undefined;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }

  /** Field-level messages from server-side validation, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    const fields = (this.details as { fields?: { field: string; message: string }[] } | undefined)?.fields ?? [];
    return Object.fromEntries(fields.map((f) => [f.field, f.message]));
  }
}

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function setSessionLostHandler(fn: () => void) {
  onSessionLost = fn;
}

export async function refreshSession(): Promise<{ accessToken: string; user: unknown } | null> {
  const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) return null;
  const data = await res.json();
  accessToken = data.accessToken;
  return data;
}

function refreshOnce(): Promise<boolean> {
  refreshInFlight ??= refreshSession()
    .then((d) => d !== null)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, query?: Query) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `/api/v1${path}${s ? `?${s}` : ''}`;
}

/**
 * Connection state for the banner in the layout. "unreachable" means the last request could not get
 * an answer at all (no signal, the TLS handshake timed out, the server is down); the next request
 * that succeeds clears it.
 */
export type ConnectionState = 'online' | 'offline' | 'unreachable';
let connection: ConnectionState = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online';
const listeners = new Set<(s: ConnectionState) => void>();
function setConnection(next: ConnectionState) {
  if (next === connection) return;
  connection = next;
  listeners.forEach((l) => l(next));
}
export const getConnection = () => connection;
export function onConnectionChange(fn: (s: ConnectionState) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => setConnection('offline'));
  window.addEventListener('online', () => setConnection('online'));
}

export const REQUEST_TIMEOUT_MS = 20_000; // generous for mobile data, short enough not to leave a queue waiting
const RETRY_DELAY_MS = 1_500;

const NETWORK_READ = "Can't reach SizaniConnect. Check your mobile data or Wi-Fi, then try again.";
const NETWORK_WRITE =
  'The connection dropped before the server answered, so this may or may not have been saved. Check before trying again.';
const TIMEOUT_READ = 'The server took too long to answer. Check your signal and try again.';
const TIMEOUT_WRITE = 'The server took too long to answer, so this may or may not have been saved. Check before trying again.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Query; timeoutMs?: number } = {},
): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const isRead = method === 'GET';
  const send = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      return await fetch(buildUrl(path, opts.query), {
        method,
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      setConnection(navigator.onLine === false ? 'offline' : 'unreachable');
      const timedOut = (err as Error)?.name === 'AbortError';
      throw new ApiError(
        0,
        timedOut ? 'TIMEOUT' : 'NETWORK',
        timedOut ? (isRead ? TIMEOUT_READ : TIMEOUT_WRITE) : isRead ? NETWORK_READ : NETWORK_WRITE,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  // Reads change nothing, so one automatic retry is safe. Writes are never retried behind the
  // person's back: they decide, and the server's own rules stop a repeat doing harm.
  const attempt = async () => {
    try {
      const res = await send();
      if (isRead && res.status === 503) {
        await sleep(RETRY_DELAY_MS);
        return send();
      }
      return res;
    } catch (err) {
      if (!isRead) throw err;
      await sleep(RETRY_DELAY_MS);
      return send();
    }
  };

  let res = await attempt();
  setConnection('online');
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshOnce()) res = await send();
    else onSessionLost();
  }
  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = isJson ? data?.error : undefined;
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? 'The request failed. Try again.', err?.details);
  }
  return data as T;
}

/** Downloads an authenticated file (CSV exports, subject-access exports). */
export async function download(path: string, filename: string, query?: Query) {
  let res = await fetch(buildUrl(path, query), { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  if (res.status === 401 && (await refreshOnce())) {
    res = await fetch(buildUrl(path, query), { headers: { Authorization: `Bearer ${accessToken}` } });
  }
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'The download failed. Try again.');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
