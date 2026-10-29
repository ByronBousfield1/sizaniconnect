import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, getConnection } from '../lib/api';

/** Task 2 feedback: what the app does when the network or the TLS handshake times out. */
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('requests on a bad connection', () => {
  it('retries a read once after a dropped connection, then succeeds and clears the banner state', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(ok({ fine: true }));
    vi.stubGlobal('fetch', fetch);
    await expect(api('/events')).resolves.toEqual({ fine: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getConnection()).toBe('online');
  });

  it('never repeats a write behind the person’s back, and says it may or may not have been saved', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    const err = (await api('/collections', { body: { x: 1 } }).catch((e: unknown) => e)) as ApiError;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ status: 0, code: 'NETWORK' });
    expect(err.message).toMatch(/may or may not have been saved/);
    expect(getConnection()).toBe('unreachable');
  });

  it('gives up on a request that hangs (for example a stalled TLS handshake) instead of waiting for ever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      ),
    );
    const err = (await api('/collections', { body: {}, timeoutMs: 20 }).catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 0, code: 'TIMEOUT' });
  });

  it('passes on the server’s own message when the database is down', async () => {
    const down = () =>
      new Response(JSON.stringify({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The system cannot reach its database right now, so nothing was saved.' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
      });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => down()));
    const err = (await api('/households').catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE' });
  });
});
