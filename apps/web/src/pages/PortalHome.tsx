import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ROLE_LABELS, workspacePath } from '@nio/shared';
import { useAuth } from '../lib/auth';
import { canActAs, lastWorkspace, useWorkspaces } from '../lib/workspace';
import { Alert, Empty, Loading } from '../components/ui';

/**
 * Sends people straight back to where they last worked, or to their only workspace. Anyone with
 * several, or who asked to choose, gets the full list grouped by business unit.
 */
export function PortalHome() {
  const { me, provider, signInWithAuth0 } = useAuth();
  const [params] = useSearchParams();
  const workspaces = useWorkspaces(me?.email);
  if (!me) return null;

  const choosing = params.has('choose');
  const own = me.availableMemberships;
  const reachable = (slug: string, role: string) =>
    own.some((m) => m.businessUnitSlug === slug && m.role === role) ||
    (canActAs(me) && Boolean(workspaces.data?.workspaces.some((w) => w.businessUnitSlug === slug)));

  if (!choosing) {
    const last = lastWorkspace();
    if (last && reachable(last.slug, last.role)) {
      return <Navigate to={workspacePath(last.slug, last.role)} replace />;
    }
    if (own.length === 1 && !me.isPlatformAdmin) {
      return <Navigate to={workspacePath(own[0]!.businessUnitSlug, own[0]!.role)} replace />;
    }
    if (own.length === 0 && me.isPlatformAdmin && !last) {
      return <Navigate to="/portal/platform" replace />;
    }
    if (last && canActAs(me) && workspaces.isLoading) return <Loading what="workspaces" />;
  }

  const issues = me.accessIssues.filter((issue) => issue.code !== 'organization_required');
  const groups = new Map<string, { name: string; status: string; roles: typeof own }>();
  for (const membership of workspaces.data?.workspaces ?? own) {
    const group = groups.get(membership.businessUnitSlug) ?? {
      name: membership.businessUnitName,
      status: membership.businessUnitStatus,
      roles: [],
    };
    group.roles.push(membership);
    groups.set(membership.businessUnitSlug, group);
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Choose a workspace</h1>
          <p>
            Signed in as <strong>{me.email}</strong>. A workspace is one business unit and one
            role; switch any time from the Workspace menu at the top.
          </p>
        </div>
      </div>

      {issues.map((issue) => (
        <Alert key={issue.message} tone="error">
          {issue.message}
        </Alert>
      ))}

      <div className="grid cols-2">
        {me.isPlatformAdmin ? (
          me.activeOrganizationId && provider === 'auth0' ? (
            <button
              type="button"
              className="card"
              style={{ textAlign: 'left' }}
              onClick={() => void signInWithAuth0({ returnTo: '/portal/platform' })}
            >
              <div className="card-title">Platform</div>
              <h3>Super admin</h3>
              <p className="muted small">Switch to the platform workspace.</p>
            </button>
          ) : (
            <Link to="/portal/platform" className="card">
              <div className="card-title">Platform</div>
              <h3>Super admin</h3>
              <p className="muted small">
                Onboard and suspend business units, then enter any of them as any role.
              </p>
            </Link>
          )
        ) : null}

        {[...groups.entries()].map(([slug, group]) => (
          <div key={slug} className="card">
            <div className="card-title">
              {group.name}
              {group.status !== 'active' ? (
                <span className="badge pending" style={{ marginLeft: 8 }}>
                  {group.status}
                </span>
              ) : null}
            </div>
            <div className="role-chips" style={{ marginTop: 8 }}>
              {group.roles.map((membership) => (
                <Link
                  key={membership.role}
                  className="btn small"
                  to={workspacePath(slug, membership.role)}
                >
                  {ROLE_LABELS[membership.role]}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      {groups.size === 0 && !me.isPlatformAdmin && issues.length === 0 ? (
        <Empty>
          {me.email} is not a member of any business unit yet. Ask a business unit admin to add
          you from their Team page.
        </Empty>
      ) : null}
    </>
  );
}
