import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import type { MembershipRole, BusinessUnitStatus } from '@nio/shared';
import { api, getToken, setToken, setTokenResolver } from './api';
import { useAuthConfig } from './authConfig';

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

export interface SignInOptions {
  /** Auth0 organization id (org_…), which scopes the login to one business unit. */
  organization?: string;
  /** Path to land on once the round trip completes. */
  returnTo?: string;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  provider: 'dev' | 'auth0';
  /** Dev provider only; unavailable once a real tenant is configured. */
  signInAsDev: (email: string) => Promise<void>;
  /** Auth0 only; leaves the SPA for the hosted login page. */
  signInWithAuth0: (options?: SignInOptions) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>('/api/auth/me');
  } catch {
    return null;
  }
}

function DevAuth({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    const profile = await fetchMe();
    // A stale or rejected token should not leave the app in a half-signed-in state.
    if (!profile) setToken(null);
    setMe(profile);
    setLoading(false);
  }, []);

  useEffect(() => {
    setTokenResolver(null);
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      provider: 'dev',
      async signInAsDev(email: string) {
        const { accessToken } = await api<{ accessToken: string }>('/api/auth/dev/login', {
          method: 'POST',
          body: { email },
        });
        setToken(accessToken);
        await refresh();
      },
      async signInWithAuth0() {
        throw new Error('Auth0 is not configured in this environment');
      },
      logout() {
        setToken(null);
        setMe(null);
      },
      refresh,
    }),
    [me, loading, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function Auth0Auth({ children }: { children: ReactNode }) {
  const {
    isLoading,
    isAuthenticated,
    getAccessTokenSilently,
    loginWithRedirect,
    logout: auth0Logout,
  } = useAuth0();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  // Declared before the profile effect so the resolver is in place by the time anything calls the
  // API. Tokens are never persisted; the SDK renews them from a refresh token held in memory.
  useEffect(() => {
    setTokenResolver(async () => {
      if (!isAuthenticated) return null;
      try {
        return await getAccessTokenSilently();
      } catch {
        return null;
      }
    });
    return () => setTokenResolver(null);
  }, [isAuthenticated, getAccessTokenSilently]);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setMe(null);
      setLoading(false);
      return;
    }
    setMe(await fetchMe());
    setLoading(false);
  }, [isAuthenticated]);

  useEffect(() => {
    if (isLoading) return;
    void refresh();
  }, [isLoading, refresh]);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading: isLoading || loading,
      provider: 'auth0',
      async signInAsDev() {
        throw new Error('Password-less dev sign in is disabled when Auth0 is configured');
      },
      async signInWithAuth0(options?: SignInOptions) {
        await loginWithRedirect({
          appState: { returnTo: options?.returnTo ?? '/portal' },
          authorizationParams: options?.organization
            ? { organization: options.organization }
            : undefined,
        });
      },
      logout() {
        setMe(null);
        void auth0Logout({ logoutParams: { returnTo: window.location.origin } });
      },
      refresh,
    }),
    [me, loading, isLoading, loginWithRedirect, auth0Logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const config = useAuthConfig();
  // Auth0Auth calls useAuth0, which only works beneath the SDK's provider. The gate mounts that
  // provider on exactly this condition, so the two must agree or the hooks resolve to stubs.
  const useAuth0Backend = config.provider === 'auth0' && !!config.domain && !!config.clientId;

  return useAuth0Backend ? <Auth0Auth>{children}</Auth0Auth> : <DevAuth>{children}</DevAuth>;
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
