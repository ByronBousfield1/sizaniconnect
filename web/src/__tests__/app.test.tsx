import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth';
import { AppRoutes } from '../main';
import type { Role } from '../lib/types';

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown };

function mockFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const { status, body } = handler(url, init);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const user = (role: Role) => ({
  id: 'u1',
  fullName: 'Thandi Mahlangu',
  email: 't@sizani.test',
  phoneNumber: null,
  role,
  siteId: 's1',
  siteName: 'Diepsloot Extension 2 Hall',
  donorId: null,
  isActive: true,
});

const renderAt = (path: string) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe('sign in', () => {
  it('shows the server message when sign-in fails', async () => {
    mockFetch((url) =>
      url.endsWith('/auth/refresh')
        ? { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } } }
        : { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Email or password is incorrect.' } } },
    );
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 'x@sizani.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });

  it('sends a signed-out visitor to the sign-in page', async () => {
    mockFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } }));
    renderAt('/households');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('role-based navigation', () => {
  it('shows a volunteer only the screens a volunteer can use', async () => {
    mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) return { status: 200, body: { accessToken: 't', user: user('Volunteer') } };
      return { status: 200, body: [] };
    });
    renderAt('/shifts');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav).toHaveTextContent('Shifts');
    expect(nav).toHaveTextContent('Event desk');
    expect(nav).not.toHaveTextContent('Households');
    expect(nav).not.toHaveTextContent('Users');
  });

  it('redirects a volunteer away from an administrator screen', async () => {
    mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) return { status: 200, body: { accessToken: 't', user: user('Volunteer') } };
      return { status: 200, body: [] };
    });
    renderAt('/admin/users');
    expect(await screen.findByRole('heading', { name: 'Volunteer shifts' })).toBeInTheDocument();
  });
});

describe('event desk', () => {
  const event = {
    id: 'e1', siteId: 's1', siteName: 'Diepsloot Extension 2 Hall', scheduledDate: '2026-10-05', startTime: '08:00', endTime: '16:00',
    plannedParcels: 60, minVolunteers: 2, status: 'Open', collectionCount: 1, checkedInVolunteers: 2,
  };

  it('stops the volunteer when a household has already collected', async () => {
    mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) return { status: 200, body: { accessToken: 't', user: user('Volunteer') } };
      if (url.includes('/events?')) return { status: 200, body: [event] };
      if (url.includes('/collections')) return { status: 200, body: [] };
      if (url.includes('/households/by-ref/')) {
        return {
          status: 200,
          body: {
            id: 'h1', referenceCode: 'SZN-2026-7K4QX2', headOfHousehold: 'Nomsa Dlamini', suburb: 'Diepsloot', homeSiteName: 'Diepsloot',
            status: 'Active', memberCount: 4, parcelSize: 'Medium', lastCollectedAt: null,
            alreadyCollected: { collectedAt: '2026-10-05T08:12:00Z', verifiedByName: 'Ayanda Cele' },
          },
        };
      }
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nope' } } };
    });
    renderAt('/desk');
    await userEvent.type(await screen.findByLabelText('Household reference code'), 'szn-2026-7k4qx2');
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Already collected');
    expect(alert).toHaveTextContent('Ayanda Cele');
    expect(screen.queryByRole('button', { name: 'Record collection' })).not.toBeInTheDocument();
    // A volunteer cannot override; only the coordinator can.
    expect(screen.queryByRole('button', { name: 'Approve a second parcel' })).not.toBeInTheDocument();
  });

  it('records an eligible household and shows what to hand over', async () => {
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/auth/refresh')) return { status: 200, body: { accessToken: 't', user: user('SiteCoordinator') } };
      if (url.includes('/events?')) return { status: 200, body: [event] };
      if (url.includes('/events/e1/collections')) return { status: 200, body: [] };
      if (url.includes('/households/by-ref/')) {
        return {
          status: 200,
          body: { id: 'h2', referenceCode: 'SZN-2026-ABCDEF', headOfHousehold: 'Thabo Mokoena', suburb: 'Diepsloot', homeSiteName: 'Diepsloot', status: 'Active', memberCount: 7, parcelSize: 'Large', lastCollectedAt: null, alreadyCollected: null },
        };
      }
      if (url.endsWith('/collections') && init?.method === 'POST') {
        return {
          status: 201,
          body: { id: 'c1', parcelSize: 'Large', isOverride: false, headOfHousehold: 'Thabo Mokoena', referenceCode: 'SZN-2026-ABCDEF', issued: [{ itemName: 'Maize meal 10 kg', unitOfMeasure: 'bag', quantity: 2 }] },
        };
      }
      return { status: 404, body: {} };
    });
    renderAt('/desk');
    await userEvent.type(await screen.findByLabelText('Household reference code'), 'SZN-2026-ABCDEF');
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Record collection' }));
    await waitFor(() => expect(screen.getByText(/Hand over a large parcel/)).toBeInTheDocument());
    expect(screen.getByText(/2 bag Maize meal 10 kg/)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/collections') && init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ eventId: 'e1', householdId: 'h2' });
  });
});
