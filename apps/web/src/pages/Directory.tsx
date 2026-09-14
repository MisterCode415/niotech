import { Link } from 'react-router-dom';

export function Directory() {
  return (
    <div className="centered">
      <div className="auth-card">
        <h1>
          Qin<span style={{ color: 'var(--accent)' }}>io</span>
        </h1>
        <p className="muted">
          Health testing and results, focused on the people and outcomes that matter.
        </p>
        <Link to="/login" className="btn primary">
          Sign in
        </Link>
      </div>
    </div>
  );
}
