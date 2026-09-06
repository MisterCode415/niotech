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
  const { me, provider, signInWithAuth0 } = useAuth();
  if (!me) return null;

  const destinations = me.availableMemberships.map((membership) => ({
    membership,
    to: ROLE_HOME[membership.role]?.(membership.businessUnitSlug) ?? '/portal',
    isActive: me.memberships.some(
      (active) =>
        active.businessUnitId === membership.businessUnitId && active.role === membership.role,
    ),
  }));

  if (destinations.length === 0 && me.isPlatformAdmin) {
    return <Navigate to="/portal/platform" replace />;
  }
  if (destinations.length === 1 && destinations[0]!.isActive && !me.isPlatformAdmin) {
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
          me.activeOrganizationId && provider === 'auth0' ? (
            <button
              type="button"
              className="card"
              style={{ textAlign: 'left' }}
              onClick={() =>
                void signInWithAuth0({
                  returnTo: '/portal/platform',
                })
              }
            >
              <div className="card-title">Platform</div>
              <h3>Superadmin</h3>
              <p className="muted small">Switch to the unscoped platform workspace.</p>
            </button>
          ) : (
            <Link to="/portal/platform" className="card">
              <div className="card-title">Platform</div>
              <h3>Superadmin</h3>
              <p className="muted small">
                Add, suspend and remove the business units that run on the platform.
              </p>
            </Link>
          )
        ) : null}

        {destinations.map(({ membership, to, isActive }) => {
          const content = (
            <>
              <div className="card-title">{membership.businessUnitName}</div>
              <h3>{ROLE_LABELS[membership.role]}</h3>
              <p className="muted small">
                {membership.businessUnitStatus === 'active'
                  ? isActive
                    ? 'Current workspace'
                    : 'Switch workspace'
                  : `Business unit is ${membership.businessUnitStatus}`}
              </p>
            </>
          );

          return isActive || provider === 'dev' ? (
            <Link key={`${membership.businessUnitId}-${membership.role}`} to={to} className="card">
              {content}
            </Link>
          ) : (
            <button
              key={`${membership.businessUnitId}-${membership.role}`}
              type="button"
              className="card"
              style={{ textAlign: 'left' }}
              disabled={!membership.auth0OrgId}
              onClick={() =>
                void signInWithAuth0({
                  organization: membership.auth0OrgId ?? undefined,
                  returnTo: to,
                })
              }
            >
              {content}
            </button>
          );
        })}
      </div>

      {destinations.length === 0 && !me.isPlatformAdmin ? (
        <Empty>You are not a member of any business unit yet.</Empty>
      ) : null}
    </>
  );
}
