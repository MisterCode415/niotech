import { NavLink, Outlet, Link } from 'react-router-dom';
import { ROLE_LABELS, type MembershipRole } from '@nio/shared';
import { useAuth } from '../lib/auth';
import { NotificationBell } from './NotificationBell';

interface NavItem {
  to: string;
  label: string;
}

/** Each role gets only its own portal in the nav; the API enforces the same boundary. */
function navFor(
  role: MembershipRole,
  slug: string,
): NavItem[] {
  switch (role) {
    case 'bu_admin':
      return [
        { to: `/portal/admin/${slug}`, label: 'Overview' },
        { to: `/portal/admin/${slug}/packages`, label: 'Packages' },
        { to: `/portal/admin/${slug}/marketing`, label: 'Marketing page' },
        { to: `/portal/admin/${slug}/team`, label: 'Team' },
        { to: `/portal/admin/${slug}/orders`, label: 'Orders' },
      ];
    case 'patient':
      return [
        { to: '/portal/orders', label: 'My orders' },
        { to: `/${slug}`, label: 'Shop' },
      ];
    case 'fulfillment':
      return [
        { to: '/portal/fulfillment', label: 'Order queue' },
        { to: '/portal/fulfillment/billing', label: 'Billing' },
      ];
    case 'lab':
      return [{ to: '/portal/lab', label: 'Lab queue' }];
    case 'doctor':
      return [{ to: '/portal/doctor', label: 'Review queue' }];
    default:
      return [];
  }
}

export function Layout() {
  const { me, logout } = useAuth();

  const items: NavItem[] = [];
  if (me?.isPlatformAdmin && !me.activeOrganizationId) {
    items.push({ to: '/portal/platform', label: 'Platform' });
  }
  for (const membership of me?.memberships ?? []) {
    items.push(...navFor(membership.role, membership.businessUnitSlug));
  }
  if (
    (me?.availableMemberships.length ?? 0) > (me?.memberships.length ?? 0) ||
    (me?.isPlatformAdmin && Boolean(me.activeOrganizationId))
  ) {
    items.push({ to: '/portal', label: 'Workspaces' });
  }

  const seen = new Set<string>();
  const uniqueItems = items.filter((item) => {
    if (seen.has(item.to)) return false;
    seen.add(item.to);
    return true;
  });

  const roles = (me?.memberships ?? []).map(
    (m) => `${ROLE_LABELS[m.role]} @ ${m.businessUnitName}`,
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/portal" className="brand">
          NIO<span>Tech</span>
        </Link>

        <nav className="topnav">
          {uniqueItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to.split('/').length <= 3}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="topbar-right">
          <NotificationBell />
          <div className="small muted" title={roles.join(', ')}>
            {me?.name}
          </div>
          <button className="small" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
