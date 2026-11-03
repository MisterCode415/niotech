import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { workspacePath } from '@nio/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { readHandoff } from '../lib/handoff';
import { money } from '../lib/format';
import { Alert, Loading } from '../components/ui';
import { OrderSummary } from '../components/OrderSummary';
import { EMPTY_SHIPPING_ADDRESS, ShippingFields } from '../components/ShippingFields';

interface PackageRow {
  id: string;
  name: string;
  priceCents: number;
  requiresClinician: boolean;
  kitCount: number;
}

export function Checkout() {
  const { slug = '', packageId = '' } = useParams();
  const navigate = useNavigate();

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
      const { order } = await api<{ order: { id: string } }>(`/api/bu/${slug}/patient/orders`, {
        method: 'POST',
        body: {
          packageId,
          shippingAddress: { ...address, line2: address.line2 || undefined },
          shippingMethod,
          ...(handoff?.attribution ? { attribution: handoff.attribution } : {}),
          ...(handoff?.intentId ? { intentId: handoff.intentId } : {}),
        },
      });

      // Payment is mocked for now, but it is a separate call so a real processor slots in here.
      const payment = await api<{ checkoutUrl?: string }>(
        `/api/bu/${slug}/patient/orders/${order.id}/pay`,
        {
          method: 'POST',
          body: { paymentToken: 'mock-token' },
        },
      );
      if (payment.checkoutUrl) {
        window.location.assign(payment.checkoutUrl);
        return;
      }

      navigate(workspacePath(slug, 'patient', `/orders/${order.id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not place the order');
    } finally {
      setBusy(false);
    }
  }

  if (catalog.isLoading) return <Loading what="package" />;
  if (!pkg) return <Alert tone="error">That package is no longer available.</Alert>;

  return (
    <>
      <div className="page-header">
        <div>
          <Link to={`/${slug}`} className="small muted">
            ← Back to storefront
          </Link>
          <h1 style={{ marginTop: 8 }}>Checkout</h1>
          <p>Where should we send your test kit?</p>
        </div>
      </div>

      <div className="grid cols-2">
        <form className="card" onSubmit={submit}>
          <Alert tone="error">{error}</Alert>

          <ShippingFields
            address={address}
            onAddress={setAddress}
            shippingMethod={shippingMethod}
            onShippingMethod={setShippingMethod}
          />

          <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Placing order…' : `Pay ${money(pkg.priceCents)}`}
          </button>
          <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
            You will continue to secure payment after confirming your shipping details.
          </p>
        </form>

        <OrderSummary pkg={pkg} />
      </div>
    </>
  );
}
