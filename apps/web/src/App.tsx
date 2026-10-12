import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { workspacePath, type MembershipRole } from '@nio/shared';
import { ActAsSync, useAuth } from './lib/auth';
import { loginPathFor } from './lib/returnTo';
import {
  canActAs,
  lastWorkspace,
  rememberWorkspace,
  sessionMembershipFor,
} from './lib/workspace';
import { Layout } from './components/Layout';
import { Empty, Loading } from './components/ui';

import { Login } from './pages/Login';
import { Directory } from './pages/Directory';
import { Storefront } from './pages/Storefront';
import { Register } from './pages/Register';
import { Checkout } from './pages/Checkout';
import { CheckoutReturn } from './pages/CheckoutReturn';
import { PortalHome } from './pages/PortalHome';
import { ScanEntry, ScanPage } from './pages/ScanPage';
import { AccessProblem } from './pages/AccessProblem';

import { PlatformDashboard } from './pages/platform/PlatformDashboard';
import { PlatformAi } from './pages/platform/PlatformAi';
import { AdminOverview } from './pages/admin/AdminOverview';
import { AdminAi } from './pages/admin/AdminAi';
import { AdminAudit } from './pages/admin/AdminAudit';
import { AdminPackages } from './pages/admin/AdminPackages';
import { AdminMarketing } from './pages/admin/AdminMarketing';
import { AdminTeam } from './pages/admin/AdminTeam';
import { AdminOrders } from './pages/admin/AdminOrders';
import { AdminPayments } from './pages/admin/AdminPayments';
import { PatientOrders } from './pages/patient/PatientOrders';
import { PatientOrderDetail } from './pages/patient/PatientOrderDetail';
import { FulfillmentQueue } from './pages/fulfillment/FulfillmentQueue';
import { FulfillmentOrder } from './pages/fulfillment/FulfillmentOrder';
import { FulfillmentBilling } from './pages/fulfillment/FulfillmentBilling';
import { LabQueue } from './pages/lab/LabQueue';
import { LabOrder } from './pages/lab/LabOrder';
import { DoctorQueue } from './pages/doctor/DoctorQueue';
import { DoctorReview } from './pages/doctor/DoctorReview';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loading, authError } = useAuth();
  const location = useLocation();
  if (loading) return <div className="centered">Loading…</div>;
  if (authError) return <AccessProblem message={authError} />;
  if (!me) return <Navigate to={loginPathFor(location.pathname + location.search)} replace />;
  return <>{children}</>;
}

/**
 * Client-side gating is a navigation convenience only; the API enforces the same boundary. A
 * member whose token is scoped to another organization is re-signed into this one, and a
 * platform admin enters through the audited act-as header.
 */
function RequireWorkspace({ role, children }: { role: MembershipRole; children: React.ReactNode }) {
  const { me, loading, provider, signInWithAuth0 } = useAuth();
  const { slug = '' } = useParams();
  const location = useLocation();
  const ref = { slug, role };
  const usable = Boolean(sessionMembershipFor(me, ref)) || canActAs(me);
  const switchable = me?.availableMemberships.find(
    (m) => m.businessUnitSlug === slug && m.role === role,
  );
  const needsOrgSwitch = !usable && provider === 'auth0' && Boolean(switchable?.auth0OrgId);

  useEffect(() => {
    if (usable) rememberWorkspace(ref);
  }, [usable, slug, role]);

  useEffect(() => {
    if (!needsOrgSwitch) return;
    void signInWithAuth0({
      organization: switchable!.auth0OrgId!,
      returnTo: location.pathname + location.search,
    });
  }, [needsOrgSwitch]);

  if (loading) return <Loading />;
  if (needsOrgSwitch) {
    return <div className="centered">Switching to {switchable!.businessUnitName}…</div>;
  }
  if (!usable) return <Empty>You do not have access to this workspace.</Empty>;
  return <>{children}</>;
}

function RequirePlatformAdmin({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Loading />;
  if (!me?.isPlatformAdmin) return <Empty>Platform administrator access required.</Empty>;
  if (me.activeOrganizationId) {
    return <Navigate to="/portal" replace />;
  }
  return <>{children}</>;
}

/** Old `/portal/...` links (bookmarks, earlier emails) predate business-unit-scoped URLs. */
function LegacyRedirect({ role, subPath = '' }: { role: MembershipRole; subPath?: string }) {
  const { me } = useAuth();
  const params = useParams();
  const resolvedSub = subPath.replace(/:(\w+)/g, (_, key: string) => params[key] ?? '');
  const last = lastWorkspace();
  const slug =
    params.slug ??
    (last?.role === role ? last.slug : undefined) ??
    me?.availableMemberships.find((m) => m.role === role)?.businessUnitSlug;
  if (!slug) return <Navigate to="/portal" replace />;
  return <Navigate to={workspacePath(slug, role, resolvedSub)} replace />;
}

function workspaceRoute(role: MembershipRole, path: string, element: React.ReactNode) {
  return (
    <Route
      key={path}
      path={path}
      element={<RequireWorkspace role={role}>{element}</RequireWorkspace>}
    />
  );
}

export function App() {
  return (
    <>
      <ActAsSync />
      <Routes>
        <Route path="/" element={<Directory />} />
        <Route path="/login" element={<Login />} />
        {/* Auth0 returns here with its authorization code. The SDK exchanges it during mount and
            then redirects, so this is only ever on screen for a moment. */}
        <Route path="/callback" element={<div className="centered">Signing in…</div>} />
        <Route path="/:slug" element={<Storefront />} />
        <Route path="/:slug/register" element={<Register />} />

        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/:slug/checkout/:packageId" element={<Checkout />} />
          <Route path="/checkout/return" element={<CheckoutReturn />} />
          <Route path="/scan" element={<ScanEntry />} />
          <Route path="/scan/:code" element={<ScanPage />} />

          <Route path="/portal" element={<PortalHome />} />
          <Route
            path="/portal/platform"
            element={
              <RequirePlatformAdmin>
                <PlatformDashboard />
              </RequirePlatformAdmin>
            }
          />
          <Route
            path="/portal/platform/ai"
            element={
              <RequirePlatformAdmin>
                <PlatformAi />
              </RequirePlatformAdmin>
            }
          />

          {workspaceRoute('bu_admin', '/w/:slug/admin', <AdminOverview />)}
          {workspaceRoute('bu_admin', '/w/:slug/admin/packages', <AdminPackages />)}
          {workspaceRoute('bu_admin', '/w/:slug/admin/marketing', <AdminMarketing />)}
          {workspaceRoute('bu_admin', '/w/:slug/admin/team', <AdminTeam />)}
          {workspaceRoute('bu_admin', '/w/:slug/admin/orders', <AdminOrders />)}
          {workspaceRoute('bu_admin', '/w/:slug/admin/payments', <AdminPayments />)}
          {workspaceRoute('bu_admin', '/w/:slug/admin/ai', <AdminAi />)}
          {workspaceRoute('bu_admin', '/w/:slug/admin/audit', <AdminAudit />)}
          {workspaceRoute('patient', '/w/:slug/patient/orders', <PatientOrders />)}
          {workspaceRoute('patient', '/w/:slug/patient/orders/:orderId', <PatientOrderDetail />)}
          {workspaceRoute('fulfillment', '/w/:slug/fulfillment', <FulfillmentQueue />)}
          {workspaceRoute('fulfillment', '/w/:slug/fulfillment/billing', <FulfillmentBilling />)}
          {workspaceRoute(
            'fulfillment',
            '/w/:slug/fulfillment/orders/:orderId',
            <FulfillmentOrder />,
          )}
          {workspaceRoute('lab', '/w/:slug/lab', <LabQueue />)}
          {workspaceRoute('lab', '/w/:slug/lab/orders/:orderId', <LabOrder />)}
          {workspaceRoute('doctor', '/w/:slug/doctor', <DoctorQueue />)}
          {workspaceRoute('doctor', '/w/:slug/doctor/reviews/:orderId', <DoctorReview />)}
          <Route path="/w/:slug/patient" element={<LegacyRedirect role="patient" />} />

          <Route path="/portal/admin/:slug" element={<LegacyRedirect role="bu_admin" />} />
          <Route
            path="/portal/admin/:slug/:section"
            element={<LegacyRedirect role="bu_admin" subPath="/:section" />}
          />
          <Route path="/portal/orders" element={<LegacyRedirect role="patient" />} />
          <Route
            path="/portal/orders/:orderId"
            element={<LegacyRedirect role="patient" subPath="/orders/:orderId" />}
          />
          <Route path="/portal/fulfillment" element={<LegacyRedirect role="fulfillment" />} />
          <Route
            path="/portal/fulfillment/billing"
            element={<LegacyRedirect role="fulfillment" subPath="/billing" />}
          />
          <Route
            path="/portal/fulfillment/orders/:orderId"
            element={<LegacyRedirect role="fulfillment" subPath="/orders/:orderId" />}
          />
          <Route path="/portal/lab" element={<LegacyRedirect role="lab" />} />
          <Route
            path="/portal/lab/orders/:orderId"
            element={<LegacyRedirect role="lab" subPath="/orders/:orderId" />}
          />
          <Route path="/portal/doctor" element={<LegacyRedirect role="doctor" />} />
          <Route
            path="/portal/doctor/reviews/:orderId"
            element={<LegacyRedirect role="doctor" subPath="/reviews/:orderId" />}
          />

          <Route path="*" element={<Empty>Page not found.</Empty>} />
        </Route>
      </Routes>
    </>
  );
}
