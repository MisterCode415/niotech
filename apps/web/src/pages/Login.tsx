import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { Alert, Field } from '../components/ui';

const DEV_PERSONAS = [
  { email: 'admin@niotech.test', role: 'Platform superadmin' },
  { email: 'admin@vitality.test', role: 'Business unit admin — Vitality' },
  { email: 'patient@vitality.test', role: 'Patient — Vitality' },
  { email: 'fulfillment@vitality.test', role: 'Fulfillment — Vitality' },
  { email: 'lab@vitality.test', role: 'Lab — Vitality' },
  { email: 'doctor@vitality.test', role: 'Doctor — Vitality' },
  { email: 'admin@metabolic.test', role: 'Business unit admin — Metabolic Co' },
];

interface LoginHandoff {
  businessUnit: { name: string; slug: string };
  organization: string | null;
}

export function Login() {
  const { me, signInAsDev, signInWithAuth0, provider, loading } = useAuth();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Arriving from a storefront scopes the login to that tenant's Auth0 organization; arriving
  // directly (a platform admin, say) has no organization and uses the plain tenant login.
  const orgSlug = searchParams.get('org');
  const handoff = useQuery({
    queryKey: ['login-handoff', orgSlug],
    queryFn: () => api<LoginHandoff>(`/api/public/${orgSlug}/login`),
    enabled: Boolean(orgSlug) && provider === 'auth0',
  });

  if (loading) return <div className="centered">Loading…</div>;
  if (me) return <Navigate to="/portal" replace />;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
      setBusy(false);
    }
  }

  const isAuth0 = provider === 'auth0';

  return (
    <div className="centered">
      <div className="auth-card">
        <h1>
          Qin<span style={{ color: 'var(--accent)' }}>io</span>
        </h1>
        <p className="muted">Testing and lab workflow platform.</p>

        <Alert tone="error">{error}</Alert>

        {isAuth0 ? (
          <>
            {handoff.data ? (
              <Alert tone="info">Signing in to {handoff.data.businessUnit.name}.</Alert>
            ) : null}

            {orgSlug && handoff.isError ? (
              <Alert tone="error">
                That business unit could not be found. You can still sign in below.
              </Alert>
            ) : null}

            {handoff.data && !handoff.data.organization ? (
              <Alert tone="info">
                This business unit has no Auth0 organization yet, so the standard login applies.
              </Alert>
            ) : null}

            <button
              className="primary"
              type="button"
              style={{ width: '100%' }}
              disabled={busy || (Boolean(orgSlug) && handoff.isLoading)}
              onClick={() =>
                void run(() =>
                  signInWithAuth0({
                    organization: handoff.data?.organization ?? undefined,
                    returnTo: searchParams.get('returnTo') ?? '/portal',
                  }),
                )
              }
            >
              {busy ? 'Redirecting…' : 'Continue to sign in'}
            </button>
          </>
        ) : (
          <>
            <Alert tone="info">
              Running with the local development identity provider. Accounts must already exist —
              signing in never creates one.
            </Alert>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => signInAsDev(email));
              }}
            >
              <Field label="Email address">
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </Field>
              <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <div className="card-title" style={{ marginTop: 22 }}>
              Seeded accounts
            </div>
            {DEV_PERSONAS.map((persona) => (
              <button
                key={persona.email}
                className="persona"
                disabled={busy}
                onClick={() => void run(() => signInAsDev(persona.email))}
              >
                <span>
                  <span className="small mono">{persona.email}</span>
                  <br />
                  <span className="small muted">{persona.role}</span>
                </span>
                <span className="muted">→</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
