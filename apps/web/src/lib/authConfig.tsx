import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Auth0Provider, type AppState } from '@auth0/auth0-react';
import { api } from './api';

export interface AuthConfig {
  provider: 'dev' | 'auth0';
  /** Present only when provider === 'auth0'. */
  domain?: string;
  clientId?: string;
  audience?: string;
}

const AuthConfigContext = createContext<AuthConfig>({ provider: 'dev' });

export function useAuthConfig(): AuthConfig {
  return useContext(AuthConfigContext);
}

/**
 * Which identity provider is in play is a server decision, so it is fetched rather than baked in
 * at build time — the same bundle can be deployed against a dev stack and a real tenant. Auth0's
 * provider needs its domain and client id at mount time, so nothing below can render until the
 * answer arrives.
 */
export function AuthConfigGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void api<AuthConfig>('/api/auth/config')
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch(() => {
        // Falling back to dev keeps the login screen reachable so the failure is visible there,
        // rather than leaving a blank page with the reason buried in the console.
        if (!cancelled) setConfig({ provider: 'dev' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!config) return <div className="centered">Loading…</div>;

  if (config.provider !== 'auth0' || !config.domain || !config.clientId) {
    return <AuthConfigContext.Provider value={config}>{children}</AuthConfigContext.Provider>;
  }

  return (
    <AuthConfigContext.Provider value={config}>
      <Auth0Provider
        domain={config.domain}
        clientId={config.clientId}
        authorizationParams={{
          redirect_uri: `${window.location.origin}/callback`,
          audience: config.audience,
        }}
        // Access tokens stay in memory and are renewed with a rotating refresh token. The
        // alternative, silent authentication in a hidden iframe, depends on third-party cookies
        // that browsers now block by default.
        useRefreshTokens
        cacheLocation="memory"
        // Replaces the entry so the callback URL, complete with its authorization code, does not
        // sit in history where a back button would replay a spent code.
        onRedirectCallback={(appState?: AppState) =>
          navigate(appState?.returnTo ?? '/portal', { replace: true })
        }
      >
        {children}
      </Auth0Provider>
    </AuthConfigContext.Provider>
  );
}
