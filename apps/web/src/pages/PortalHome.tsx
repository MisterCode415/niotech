import { Link, Navigate } from 'react-router-dom';
import { ROLE_LABELS } from '@nio/shared';
import { useAuth } from '../lib/auth';
import { Empty } from '../components/ui';

const ROLE_HOME: Record<string, (slug: string) => string> = {
  bu_admin: (slug) => `/portal/admin/${slug}`,
  patient: () => '/portal/orders',
  fulfillment: () => '/portal/fulfillment',
  lab: () => '/portal/lab',
  doctor: () => '/portal/doctor',
};

/** Sends a single-role user straight to their portal; anyone with several picks one. */
export function PortalHome() {
  const { me } = useAuth();
  if (!me) return null;

  const destinations = me.memberships.map((membership) => ({
    membership,
    to: ROLE_HOME[membership.role]?.(membership.businessUnitSlug) ?? '/portal',
  }));

  if (destinations.length === 0 && me.isPlatformAdmin) {
    return <Navigate to="/portal/platform" replace />;
  }
  if (destinations.length === 1 && !me.isPlatformAdmin) {
    return <Navigate to={destinations[0]!.to} replace />;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Choose a workspace</h1>
          <p>You hold more than one role. Pick where you want to work.</p>
        </div>
      </div>

      <div className="grid cols-2">
        {me.isPlatformAdmin ? (
          <Link to="/portal/platform" className="card">
            <div className="card-title">Platform</div>
            <h3>Superadmin</h3>
            <p className="muted small">
              Add, suspend and remove the business units that run on the platform.
            </p>
          </Link>
        ) : null}

        {destinations.map(({ membership, to }) => (
          <Link key={`${membership.businessUnitId}-${membership.role}`} to={to} className="card">
            <div className="card-title">{membership.businessUnitName}</div>
            <h3>{ROLE_LABELS[membership.role]}</h3>
            <p className="muted small">
              {membership.businessUnitStatus === 'active'
                ? 'Active'
                : `Business unit is ${membership.businessUnitStatus}`}
            </p>
          </Link>
        ))}
      </div>

      {destinations.length === 0 && !me.isPlatformAdmin ? (
        <Empty>You are not a member of any business unit yet.</Empty>
      ) : null}
    </>
  );
}
