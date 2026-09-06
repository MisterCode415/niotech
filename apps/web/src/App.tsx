import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import type { MembershipRole } from '@nio/shared';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Empty, Loading } from './components/ui';

import { Login } from './pages/Login';
import { Directory } from './pages/Directory';
import { Storefront } from './pages/Storefront';
import { Register } from './pages/Register';
import { Checkout } from './pages/Checkout';
import { PortalHome } from './pages/PortalHome';
import { ScanPage } from './pages/ScanPage';

import { PlatformDashboard } from './pages/platform/PlatformDashboard';
import { AdminOverview } from './pages/admin/AdminOverview';
import { AdminPackages } from './pages/admin/AdminPackages';
import { AdminMarketing } from './pages/admin/AdminMarketing';
import { AdminTeam } from './pages/admin/AdminTeam';
import { AdminOrders } from './pages/admin/AdminOrders';
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
  const { me, loading } = useAuth();
  if (loading) return <div className="centered">Loading…</div>;
  if (!me) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/**
 * Client-side role gating is a navigation convenience only. Every route below is independently
 * enforced by the API, which is the boundary that actually matters.
 */
function RequireRole({ role, children }: { role: MembershipRole; children: React.ReactNode }) {
  const { me, loading } = useAuth();
  const { slug } = useParams();
  if (loading) return <Loading />;
  const matches = (membership: { role: MembershipRole; businessUnitSlug: string }) =>
    membership.role === role && (!slug || membership.businessUnitSlug === slug);

  if (!me?.memberships.some(matches)) {
    if (me?.availableMemberships.some(matches)) {
      return <Navigate to="/portal" replace />;
    }
    return <Empty>You do not have access to this area.</Empty>;
  }
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

export function App() {
  return (
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
        <Route path="/scan/:token" element={<ScanPage />} />

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
          path="/portal/admin/:slug"
          element={
            <RequireRole role="bu_admin">
              <AdminOverview />
            </RequireRole>
          }
        />
        <Route
          path="/portal/admin/:slug/packages"
          element={
            <RequireRole role="bu_admin">
              <AdminPackages />
            </RequireRole>
          }
        />
        <Route
          path="/portal/admin/:slug/marketing"
          element={
            <RequireRole role="bu_admin">
              <AdminMarketing />
            </RequireRole>
          }
        />
        <Route
          path="/portal/admin/:slug/team"
          element={
            <RequireRole role="bu_admin">
              <AdminTeam />
            </RequireRole>
          }
        />
        <Route
          path="/portal/admin/:slug/orders"
          element={
            <RequireRole role="bu_admin">
              <AdminOrders />
            </RequireRole>
          }
        />

        <Route
          path="/portal/orders"
          element={
            <RequireRole role="patient">
              <PatientOrders />
            </RequireRole>
          }
        />
        <Route
          path="/portal/orders/:orderId"
          element={
            <RequireRole role="patient">
              <PatientOrderDetail />
            </RequireRole>
          }
        />

        <Route
          path="/portal/fulfillment"
          element={
            <RequireRole role="fulfillment">
              <FulfillmentQueue />
            </RequireRole>
          }
        />
        <Route
          path="/portal/fulfillment/billing"
          element={
            <RequireRole role="fulfillment">
              <FulfillmentBilling />
            </RequireRole>
          }
        />
        <Route
          path="/portal/fulfillment/orders/:orderId"
          element={
            <RequireRole role="fulfillment">
              <FulfillmentOrder />
            </RequireRole>
          }
        />

        <Route
          path="/portal/lab"
          element={
            <RequireRole role="lab">
              <LabQueue />
            </RequireRole>
          }
        />
        <Route
          path="/portal/lab/orders/:orderId"
          element={
            <RequireRole role="lab">
              <LabOrder />
            </RequireRole>
          }
        />

        <Route
          path="/portal/doctor"
          element={
            <RequireRole role="doctor">
              <DoctorQueue />
            </RequireRole>
          }
        />
        <Route
          path="/portal/doctor/reviews/:orderId"
          element={
            <RequireRole role="doctor">
              <DoctorReview />
            </RequireRole>
          }
        />

        <Route path="*" element={<Empty>Page not found.</Empty>} />
      </Route>
    </Routes>
  );
}
