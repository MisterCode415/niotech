import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MembershipRole, BusinessUnitStatus } from '@nio/shared';
import { api, getToken, setToken } from './api';

export interface Membership {
  businessUnitId: string;
  businessUnitSlug: string;
  businessUnitName: string;
  businessUnitStatus: BusinessUnitStatus;
  role: MembershipRole;
}

export interface Me {
  email: string;
  name: string;
  userId: string | null;
  isPlatformAdmin: boolean;
  memberships: Membership[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  provider: string;
  login: (email: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState('dev');

  async function refresh() {
    if (!getToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await api<Me>('/api/auth/me'));
    } catch {
      // A stale or rejected token should not leave the app in a half-signed-in state.
      setToken(null);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void api<{ provider: string }>('/api/auth/config')
      .then((config) => setProvider(config.provider))
      .catch(() => setProvider('dev'));
    void refresh();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      provider,
      async login(email: string) {
        const { accessToken } = await api<{ accessToken: string }>('/api/auth/dev/login', {
          method: 'POST',
          body: { email },
        });
        setToken(accessToken);
        await refresh();
      },
      logout() {
        setToken(null);
        setMe(null);
      },
      refresh,
    }),
    [me, loading, provider],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

/** The membership that satisfies a given role, used to pick which portal a user can open. */
export function useMembership(role: MembershipRole): Membership | null {
  const { me } = useAuth();
  return me?.memberships.find((m) => m.role === role) ?? null;
}
