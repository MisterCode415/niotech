import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ROLE_LABELS, workspacePath, type MembershipRole } from '@nio/shared';
import { useAuth } from '../lib/auth';
import { canActAs, useWorkspace, useWorkspaces, type Workspace } from '../lib/workspace';

interface Group {
  slug: string;
  name: string;
  status: string;
  entries: Workspace[];
}

function groupByBusinessUnit(workspaces: Workspace[]): Group[] {
  const groups = new Map<string, Group>();
  for (const workspace of workspaces) {
    const group = groups.get(workspace.businessUnitSlug) ?? {
      slug: workspace.businessUnitSlug,
      name: workspace.businessUnitName,
      status: workspace.businessUnitStatus,
      entries: [],
    };
    group.entries.push(workspace);
    groups.set(workspace.businessUnitSlug, group);
  }
  return [...groups.values()];
}

/** Topbar control that always says where you are and lets you move to any other workspace. */
export function WorkspaceSwitcher() {
  const { me, signInWithAuth0, provider } = useAuth();
  const current = useWorkspace(me);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useWorkspaces(me?.email);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const onPlatform = pathname.startsWith('/portal/platform');
  const label = current
    ? `${current.businessUnitName} · ${ROLE_LABELS[current.role]}`
    : onPlatform
      ? 'Platform · Super admin'
      : 'Choose a workspace';

  const groups = groupByBusinessUnit(data?.workspaces ?? []).filter(
    (group) =>
      !filter ||
      group.name.toLowerCase().includes(filter.toLowerCase()) ||
      group.slug.includes(filter.toLowerCase()),
  );

  function go(path: string, viaPlatformSession: boolean) {
    setOpen(false);
    // An organization-scoped Auth0 session must drop back to the platform session to act as.
    if (viaPlatformSession && provider === 'auth0' && me?.activeOrganizationId) {
      void signInWithAuth0({ returnTo: path });
      return;
    }
    navigate(path);
  }

  function enter(slug: string, role: MembershipRole, actAs: boolean) {
    const isOwn = me?.availableMemberships.some(
      (m) => m.businessUnitSlug === slug && m.role === role,
    );
    go(workspacePath(slug, role), actAs && !isOwn && !canActAs(me));
  }

  return (
    <div className="switcher" ref={ref}>
      <button
        type="button"
        className={`switcher-button ${current?.isActingAs ? 'acting' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="switcher-kicker">Workspace</span>
        <span className="switcher-label">{label}</span>
        <span className="muted">▾</span>
      </button>

      {open ? (
        <div className="switcher-menu" role="menu">
          {me?.isPlatformAdmin ? (
            <>
              <button
                type="button"
                className={`switcher-item ${onPlatform ? 'current' : ''}`}
                onClick={() => go('/portal/platform', true)}
              >
                <strong>Platform</strong>
                <span className="small muted">Super admin: business units and onboarding</span>
              </button>
              <input
                className="switcher-filter"
                placeholder="Filter business units…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                autoFocus
              />
            </>
          ) : null}

          {groups.length === 0 ? (
            <div className="small muted" style={{ padding: 10 }}>
              No business units to show.
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.slug} className="switcher-group">
                <div className="switcher-group-title">
                  {group.name}
                  {group.status !== 'active' ? (
                    <span className="badge pending" style={{ marginLeft: 8 }}>
                      {group.status}
                    </span>
                  ) : null}
                </div>
                <div className="switcher-roles">
                  {group.entries.map((entry) => {
                    const isCurrent =
                      current?.slug === entry.businessUnitSlug && current.role === entry.role;
                    return (
                      <button
                        key={entry.role}
                        type="button"
                        className={`switcher-role ${isCurrent ? 'current' : ''}`}
                        onClick={() => enter(entry.businessUnitSlug, entry.role, entry.actAs)}
                      >
                        {ROLE_LABELS[entry.role]}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
