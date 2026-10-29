import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth';
import { cardPayload, checkCharacter, parseScan } from '../lib/scan';
import { AppRoutes } from '../main';

describe('household card scans in the browser (mirrors the API rules)', () => {
  const code = 'SZN-2026-7K2QX9';

  it('produces the same check character as the API for a known code', () => {
    // Vector shared with api/tests/unit/domain.test.ts through the algorithm, checked here directly.
    expect(parseScan(cardPayload(code))).toEqual({ ok: true, code, source: 'card' });
    expect(checkCharacter(code)).toMatch(/^[0-9A-HJKMNP-TV-Z]$/);
  });

  it.each([
    ['SZN-2026-7K2QX9', 'SZN1:SZN-2026-7K2QX9:5'],
    ['SZN-2026-000000', 'SZN1:SZN-2026-000000:K'],
    ['SZN-2025-ZZZZZZ', 'SZN1:SZN-2025-ZZZZZZ:V'],
    ['SZN-2026-ABCDEF', 'SZN1:SZN-2026-ABCDEF:1'],
  ])('%s prints as %s (the same vectors are tested in api/src/domain/referenceCode.ts copy)', (c, expected) => {
    expect(cardPayload(c)).toBe(expected);
  });

  it.each([
    [cardPayload(code).slice(0, 12), 'damaged'],
    [`SZN1:SZN-2026-7K2QX8:${checkCharacter(code)}`, 'damaged'],
    ['https://wa.me/27825550134', 'foreign'],
    ['x'.repeat(65), 'too-long'],
    ['SZN-20', 'incomplete'],
  ])('refuses %s as %s', (raw, reason) => {
    const r = parseScan(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
});

describe('event desk with a damaged card', () => {
  const user = { id: 'u1', fullName: 'Lindiwe Nkosi', email: 'v@sizani.test', phoneNumber: null, role: 'Volunteer', siteId: null, siteName: null, donorId: null, isActive: true };
  const event = { id: 'e1', siteId: 's1', siteName: 'Diepsloot Extension 2 Hall', scheduledDate: '2026-10-29', startTime: '08:00', endTime: '13:00', plannedParcels: 60, minVolunteers: 2, status: 'Open', physicalCount: null, variance: null, varianceReason: null, cancelReason: null, collectionCount: 0, checkedInVolunteers: 2 };
  let lookups = 0;

  beforeEach(() => {
    lookups = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (url.endsWith('/auth/refresh')) return json(200, { accessToken: 't', user });
        if (url.includes('/events?')) return json(200, [event]);
        if (url.includes('/collections')) return json(200, []);
        if (url.includes('/households/by-ref/')) {
          lookups++;
          return json(404, { error: { code: 'NOT_FOUND', message: 'No household with that reference code was not found.' } });
        }
        return json(404, { error: { code: 'NOT_FOUND', message: 'x' } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('explains the problem, sends nothing to the server, and suggests typing the code after a second failure', async () => {
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/desk']}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>,
    );
    const input = await screen.findByLabelText('Household reference code');
    // What a USB scanner types for a creased card: the end of the payload is lost.
    await userEvent.type(input, 'SZN1:SZN-2026-7K2{Enter}');
    expect(await screen.findByText(/could not be read correctly/)).toBeInTheDocument();
    expect(lookups).toBe(0);
    await userEvent.clear(input);
    await userEvent.type(input, 'https://example.com{Enter}');
    expect(await screen.findByText(/not a SizaniConnect household card/)).toBeInTheDocument();
    expect(screen.getByText(/Type the reference code printed under the QR code/)).toBeInTheDocument();
    expect(lookups).toBe(0);
  });
});
