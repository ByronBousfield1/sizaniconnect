import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, refreshSession, setAccessToken, setSessionLostHandler } from './api';
import type { Role, User } from './types';

interface AuthState {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  can: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSessionLostHandler(() => {
      setAccessToken(null);
      setUser(null);
    });
    // Restore the session from the refresh cookie after a page reload.
    refreshSession()
      .then((d) => setUser((d?.user as User) ?? null))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api<{ accessToken: string; user: User }>('/auth/login', { body: { email, password } });
    setAccessToken(res.accessToken);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    setUser(null);
  }, []);

  const can = useCallback((...roles: Role[]) => !!user && roles.includes(user.role), [user]);

  return <AuthContext.Provider value={{ user, ready, login, logout, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function homeFor(role: Role): string {
  if (role === 'Volunteer') return '/shifts';
  if (role === 'Donor') return '/donor';
  return '/overview';
}
