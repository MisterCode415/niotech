import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
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

export function Login() {
  const { me, login, provider, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (loading) return <div className="centered">Loading…</div>;
  if (me) return <Navigate to="/portal" replace />;

  async function signIn(target: string) {
    setBusy(true);
    setError('');
    try {
      await login(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <div className="auth-card">
        <h1>
          NIO<span style={{ color: 'var(--accent)' }}>Tech</span>
        </h1>
        <p className="muted">Testing and lab workflow platform.</p>

        <Alert tone="error">{error}</Alert>

        {provider === 'auth0' ? (
          <Alert tone="info">
            This environment is configured for Auth0. Start the hosted login flow to continue.
          </Alert>
        ) : (
          <Alert tone="info">
            Running with the local development identity provider. Accounts must already exist —
            signing in never creates one.
          </Alert>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void signIn(email);
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

        {provider === 'dev' ? (
          <>
            <div className="card-title" style={{ marginTop: 22 }}>
              Seeded accounts
            </div>
            {DEV_PERSONAS.map((persona) => (
              <button
                key={persona.email}
                className="persona"
                disabled={busy}
                onClick={() => void signIn(persona.email)}
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
        ) : null}
      </div>
    </div>
  );
}
