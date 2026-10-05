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

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Query } = {},
): Promise<T> {
  const send = () =>
    fetch(buildUrl(path, opts.query), {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await send();
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
