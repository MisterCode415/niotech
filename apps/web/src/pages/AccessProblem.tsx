import { useAuth } from '../lib/auth';
import { Alert } from '../components/ui';

/** The identity provider signed someone in, but the API would not accept the session. */
export function AccessProblem({ message }: { message: string }) {
  const { logout } = useAuth();
  const unverified = /not verified/i.test(message);

  return (
    <div className="centered">
      <div className="auth-card">
        <h1>
          Qin<span style={{ color: 'var(--accent)' }}>io</span>
        </h1>
        <Alert tone="error">{message}</Alert>
        {unverified ? (
          <p className="muted">
            Your account has not been activated yet. Open the invitation email from Qinio and use
            its link to choose a password; that also verifies your address. If the link expired,
            ask your business unit admin to resend the invite from their Team page.
          </p>
        ) : (
          <p className="muted">
            You signed in, but Qinio could not open a session for this account. Sign out and try
            again, or contact your business unit admin.
          </p>
        )}
        <button className="primary" style={{ width: '100%' }} onClick={logout}>
          Sign out
        </button>
      </div>
    </div>
  );
}
