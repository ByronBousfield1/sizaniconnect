import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth';
import { AppRoutes } from '../main';

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const renderAt = (path: string) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('getting back in without email (Task 2 feedback)', () => {
  it('the forgot-password page offers the recovery-code route', async () => {
    mockFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } } }));
    renderAt('/forgot-password');
    expect(await screen.findByRole('link', { name: 'Use a recovery code instead' })).toHaveAttribute('href', '/recover');
  });

  it('resets the password with a recovery code and says how many codes are left', async () => {
    const fetch = mockFetch((url) =>
      url.endsWith('/auth/recover')
        ? { status: 200, body: { message: 'Password saved.', remainingCodes: 9 } }
        : { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } } },
    );
    renderAt('/recover');
    await userEvent.type(await screen.findByLabelText('Email'), 'admin@sizani.test');
    await userEvent.type(screen.getByLabelText('Recovery code'), '7k2qx9mdra');
    await userEvent.type(screen.getByLabelText('New password'), 'Forgot-It-Again-2026');
    await userEvent.type(screen.getByLabelText('Type it again'), 'Forgot-It-Again-2026');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('You have 9 codes left.')).toBeInTheDocument();
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/auth/recover'))!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ email: 'admin@sizani.test', recoveryCode: '7k2qx9mdra', newPassword: 'Forgot-It-Again-2026' });
  });

  it('shows the server message when the code does not match', async () => {
    mockFetch((url) =>
      url.endsWith('/auth/recover')
        ? { status: 400, body: { error: { code: 'RECOVERY_FAILED', message: 'That email address and recovery code do not match. Check the code and try again.' } } }
        : { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } } },
    );
    renderAt('/recover');
    await userEvent.type(await screen.findByLabelText('Email'), 'admin@sizani.test');
    await userEvent.type(screen.getByLabelText('Recovery code'), 'AAAAA-AAAAA');
    await userEvent.type(screen.getByLabelText('New password'), 'Forgot-It-Again-2026');
    await userEvent.type(screen.getByLabelText('Type it again'), 'Forgot-It-Again-2026');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText(/do not match\. Check the code/)).toBeInTheDocument();
  });
});
