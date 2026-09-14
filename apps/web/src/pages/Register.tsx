import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Field } from '../components/ui';

export function Register() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { signInAsDev, provider } = useAuth();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const packageId = params.get('package');
  const returnTo = packageId ? `/${slug}/checkout/${packageId}` : '/portal/orders';
  const signInPath =
    `/login?org=${encodeURIComponent(slug)}` +
    `&returnTo=${encodeURIComponent(returnTo)}`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/public/${slug}/register`, {
        method: 'POST',
        body: { email, name, packageId: packageId ?? undefined },
      });

      if (provider === 'auth0') {
        setSubmitted(true);
        return;
      }

      await signInAsDev(email);
      navigate(returnTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <div className="auth-card">
        <Link to={`/${slug}`} className="small muted">
          ← Back to storefront
        </Link>
        {submitted ? (
          <>
            <h1 style={{ marginTop: 12 }}>Check your email</h1>
            <p>
              We sent account instructions to <strong>{email}</strong>. New accounts must set a
              password before signing in.
            </p>
            <p className="muted">
              The sign-in link will return you to {packageId ? 'checkout' : 'your patient portal'}.
            </p>
            <Link to={signInPath} className="btn primary" style={{ width: '100%' }}>
              I have activated my account
            </Link>
          </>
        ) : (
          <>
            <h1 style={{ marginTop: 12 }}>Create your account</h1>
            <p className="muted">You will use this to track your kit and read your results.</p>

            <Alert tone="error">{error}</Alert>

            <form onSubmit={submit}>
              <Field label="Full name">
                <input value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field label="Email address">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
                {busy ? 'Creating…' : 'Create account'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
