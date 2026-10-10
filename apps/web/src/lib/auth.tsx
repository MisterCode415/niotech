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
import { api, getToken, setActAsResolver, setToken, setTokenResolver } from './api';
import { useAuthConfig } from './authConfig';
import { actAsHeaderFor } from './workspace';
import { safeReturnTo } from './returnTo';

export interface Membership {
  businessUnitId: string;
  businessUnitSlug: string;
  businessUnitName: string;
  auth0OrgId: string | null;
  businessUnitStatus: BusinessUnitStatus;
  role: MembershipRole;
}

export interface AccessIssue {
  code:
    | 'no_account'
    | 'account_inactive'
    | 'membership_suspended'
    | 'business_unit_inactive'
    | 'organization_required';
  message: string;
}

export interface Me {
  email: string;
  name: string;
  userId: string | null;
  isPlatformAdmin: boolean;
  provider: 'dev' | 'auth0';
  activeOrganizationId: string | null;
  /** Memberships usable by the token currently in memory. */
  memberships: Membership[];
  /** Every workspace this identity may switch into. */
  availableMemberships: Membership[];
  accessIssues: AccessIssue[];
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
  /** Set when the identity provider signed someone in but the API refused the session. */
  authError: string | null;
  provider: 'dev' | 'auth0';
  /** Dev provider only; unavailable once a real tenant is configured. */
  signInAsDev: (email: string) => Promise<void>;
  /** Auth0 only; leaves the SPA for the hosted login page. */
  signInWithAuth0: (options?: SignInOptions) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function fetchMe(): Promise<{ me: Me | null; error: string | null }> {
  try {
    return { me: await api<Me>('/api/auth/me'), error: null };
  } catch (err) {
    return { me: null, error: err instanceof Error ? err.message : 'Sign in failed' };
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
    const { me: profile } = await fetchMe();
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
      authError: null,
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
    user,
  } = useAuth0();
  const [me, setMe] = useState<Me | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const activeOrganizationId =
    typeof user?.org_id === 'string' ? (user.org_id as string) : undefined;

  // Declared before the profile effect so the resolver is in place by the time anything calls the
  // API. Tokens are never persisted; the SDK renews them from a refresh token held in memory.
  useEffect(() => {
    setTokenResolver(async () => {
      if (!isAuthenticated) return null;
      try {
        return await getAccessTokenSilently({
          authorizationParams: activeOrganizationId
            ? { organization: activeOrganizationId }
            : undefined,
        });
      } catch {
        return null;
      }
    });
    return () => setTokenResolver(null);
  }, [isAuthenticated, getAccessTokenSilently, activeOrganizationId]);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setMe(null);
      setAuthError(null);
      setLoading(false);
      return;
    }
    const result = await fetchMe();
    setMe(result.me);
    setAuthError(result.error);
    setLoading(false);
  }, [isAuthenticated, activeOrganizationId]);

  useEffect(() => {
    if (isLoading) return;
    void refresh();
  }, [isLoading, refresh]);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading: isLoading || loading,
      authError,
      provider: 'auth0',
      async signInAsDev() {
        throw new Error('Password-less dev sign in is disabled when Auth0 is configured');
      },
      async signInWithAuth0(options?: SignInOptions) {
        await loginWithRedirect({
          appState: { returnTo: safeReturnTo(options?.returnTo) },
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
    [me, authError, loading, isLoading, loginWithRedirect, auth0Logout, refresh],
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

/**
 * Keeps the API client's act-as resolver pointed at the current profile. Render it before the
 * routes: it assigns during render, not in an effect, because child queries can fire before a
 * parent's effects run.
 */
export function ActAsSync() {
  const { me } = useAuth();
  setActAsResolver((path) => actAsHeaderFor(me, path));
  return null;
}
