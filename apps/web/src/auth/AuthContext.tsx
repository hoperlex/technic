import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthUser, Role } from '@technic/contracts';
import { authApi } from '../api/auth';
import { refreshSession } from '../api/client';

type Status = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  user: AuthUser | null;
  status: Status;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  setUser: (u: AuthUser) => void;
  refreshUser: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Один bootstrap на вкладку: React StrictMode иначе дважды ротирует refresh → reuse detection → разлогин. */
let bootstrapPromise: Promise<AuthUser | null> | null = null;

function bootstrapAuth(): Promise<AuthUser | null> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const ok = await refreshSession();
      if (!ok) return null;
      return authApi.me();
    })().catch(() => null);
  }
  return bootstrapPromise;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await bootstrapAuth();
      if (cancelled) return;
      if (!me) {
        setStatus('unauthenticated');
        return;
      }
      setUser(me);
      setStatus('authenticated');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      async login(email, password) {
        const res = await authApi.login({ email, password });
        bootstrapPromise = Promise.resolve(res.user);
        setUser(res.user);
        setStatus('authenticated');
        return res.user;
      },
      async logout() {
        await authApi.logout().catch(() => {});
        bootstrapPromise = Promise.resolve(null);
        setUser(null);
        setStatus('unauthenticated');
      },
      setUser: (u) => setUser(u),
      async refreshUser() {
        const me = await authApi.me();
        setUser(me);
      },
      hasRole: (...roles) => !!user?.role && roles.includes(user.role),
    }),
    [user, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth должен использоваться внутри AuthProvider');
  return ctx;
}
