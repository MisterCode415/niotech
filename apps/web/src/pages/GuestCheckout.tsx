import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { readHandoff } from '../lib/handoff';
import { money } from '../lib/format';
import { Alert, Field, Loading } from '../components/ui';
import { BrandHeader } from '../components/BrandHeader';
import { OrderSummary } from '../components/OrderSummary';
import { EMPTY_SHIPPING_ADDRESS, ShippingFields } from '../components/ShippingFields';

interface PackageRow {
  id: string;
  name: string;
  priceCents: number;
  requiresClinician: boolean;
  kitCount: number;
}

/**
 * Pay first, sign up afterwards. A shopper with no account gives an email, name, and address and
 * goes straight to payment; the account is created and the activation email sent only once the
 * payment clears. Signed-in patients are sent to the normal checkout instead.
 */
export function GuestCheckout() {
  const { slug = '', packageId = '' } = useParams();
  const navigate = useNavigate();
  const { me, loading } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState(EMPTY_SHIPPING_ADDRESS);
  const [shippingMethod, setShippingMethod] = useState<string>('ground');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const catalog = useQuery({
    queryKey: ['public', slug, 'packages'],
    queryFn: () => api<{ packages: PackageRow[] }>(`/api/public/${slug}/packages`),
  });

  const pkg = catalog.data?.packages.find((p) => p.id === packageId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const handoff = readHandoff(slug, packageId);
      const result = await api<{ checkoutUrl?: string; paid?: boolean }>(
        `/api/public/${slug}/orders`,
        {
          method: 'POST',
          body: {
            packageId,
            name,
            email,
            shippingAddress: { ...address, line2: address.line2 || undefined },
            shippingMethod,
            ...(handoff?.attribution ? { attribution: handoff.attribution } : {}),
            ...(handoff?.intentId ? { intentId: handoff.intentId } : {}),
          },
        },
      );
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      navigate(`/${slug}/thanks`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout');
    } finally {
      setBusy(false);
    }
  }

  if (loading || catalog.isLoading) return <div className="page"><Loading what="checkout" /></div>;

  const isPatientHere = me?.memberships.some(
    (m) => m.businessUnitSlug === slug && m.role === 'patient',
  );
  if (isPatientHere) return <Navigate replace to={`/${slug}/checkout/${packageId}`} />;

  if (!pkg) {
    return (
      <div className="page">
        <Alert tone="error">That package is no longer available.</Alert>
      </div>
    );
  }

  return (
    <div className="page">
      <BrandHeader />
      <div className="page-header">
        <div>
          <Link to={`/${slug}`} className="small muted">
            ← Back to storefront
          </Link>
          <h1 style={{ marginTop: 8 }}>Order your kit</h1>
          <p>No account needed to check out. We’ll email you a link to activate it afterwards.</p>
        </div>
      </div>

      <div className="grid cols-2">
        <form className="card" onSubmit={submit}>
          <Alert tone="error">{error}</Alert>

          <Field label="Full name">
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Email address" hint="Your results and account activation link go here.">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>

          <ShippingFields
            address={address}
            onAddress={setAddress}
            shippingMethod={shippingMethod}
            onShippingMethod={setShippingMethod}
          />

          <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Starting checkout…' : `Pay ${money(pkg.priceCents)}`}
          </button>
          <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
            You will continue to secure payment after confirming your details. Already have an
            account? <Link to={`/login?org=${slug}`}>Sign in</Link>.
          </p>
        </form>

        <OrderSummary pkg={pkg} />
      </div>
    </div>
  );
}
