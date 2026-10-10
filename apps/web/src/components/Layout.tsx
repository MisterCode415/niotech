import { NavLink, Outlet, Link } from 'react-router-dom';
import { ROLE_LABELS, workspacePath, type MembershipRole } from '@nio/shared';
import { useAuth } from '../lib/auth';
import { useWorkspace } from '../lib/workspace';
import { NotificationBell } from './NotificationBell';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

/** Only the current workspace's role contributes navigation; the API enforces the same boundary. */
function navFor(role: MembershipRole, slug: string): NavItem[] {
  const at = (subPath = '') => workspacePath(slug, role, subPath);
  switch (role) {
    case 'bu_admin':
      return [
        { to: at(), label: 'Overview', end: true },
        { to: at('/orders'), label: 'Orders' },
        { to: at('/packages'), label: 'Packages' },
        { to: at('/team'), label: 'Team' },
        { to: at('/payments'), label: 'Payments' },
        { to: at('/marketing'), label: 'Marketing page' },
      ];
    case 'patient':
      return [
        { to: at(), label: 'My orders' },
        { to: `/${slug}`, label: 'Shop' },
      ];
    case 'fulfillment':
      return [
        { to: at(), label: 'Order queue', end: true },
        { to: at('/billing'), label: 'Billing' },
      ];
    case 'lab':
      return [{ to: at(), label: 'Lab queue' }];
    case 'doctor':
      return [{ to: at(), label: 'Review queue' }];
  }
}

export function Layout() {
  const { me, logout } = useAuth();
  const workspace = useWorkspace(me);
  const items = workspace ? navFor(workspace.role, workspace.slug) : [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/portal?choose" className="brand">
          Qin<span>io</span>
        </Link>

        <WorkspaceSwitcher />

        <nav className="topnav">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="topbar-right">
          <NotificationBell />
          <div className="identity" title={me?.email}>
            <div className="identity-name">
              {me?.name}
              {me?.isPlatformAdmin ? <span className="badge active">Super admin</span> : null}
            </div>
            <div className="identity-email small muted mono">{me?.email}</div>
          </div>
          <button className="small" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      {workspace?.isActingAs ? (
        <div className="acting-banner">
          <span>
            Acting as <strong>{ROLE_LABELS[workspace.role]}</strong> in{' '}
            <strong>{workspace.businessUnitName}</strong> as a super admin. Everything you do here
            is recorded under your name.
          </span>
          <Link to="/portal/platform" className="btn small">
            Exit to Platform
          </Link>
        </div>
      ) : null}

      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
