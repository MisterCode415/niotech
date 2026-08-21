import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { SHIPPING_METHODS, SHIPPING_METHOD_LABELS } from '@nio/shared';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { Alert, Field, Loading } from '../components/ui';

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

  const [address, setAddress] = useState({
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    country: 'US',
  });
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
      const { order } = await api<{ order: { id: string } }>(`/api/bu/${slug}/patient/orders`, {
        method: 'POST',
        body: {
          packageId,
          shippingAddress: { ...address, line2: address.line2 || undefined },
          shippingMethod,
        },
      });

      // Payment is mocked for now, but it is a separate call so a real processor slots in here.
      await api(`/api/bu/${slug}/patient/orders/${order.id}/pay`, {
        method: 'POST',
        body: { paymentToken: 'mock-token' },
      });

      navigate(`/portal/orders/${order.id}`);
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

          <Field label="Address line 1">
            <input
              value={address.line1}
              onChange={(e) => setAddress({ ...address, line1: e.target.value })}
              required
            />
          </Field>
          <Field label="Address line 2">
            <input
              value={address.line2}
              onChange={(e) => setAddress({ ...address, line2: e.target.value })}
            />
          </Field>

          <div className="field-row">
            <Field label="City">
              <input
                value={address.city}
                onChange={(e) => setAddress({ ...address, city: e.target.value })}
                required
              />
            </Field>
            <Field label="State / region">
              <input
                value={address.region}
                onChange={(e) => setAddress({ ...address, region: e.target.value })}
                required
              />
            </Field>
            <Field label="Postal code">
              <input
                value={address.postalCode}
                onChange={(e) => setAddress({ ...address, postalCode: e.target.value })}
                required
              />
            </Field>
          </div>

          <Field label="Shipping speed">
            <select value={shippingMethod} onChange={(e) => setShippingMethod(e.target.value)}>
              {SHIPPING_METHODS.map((method) => (
                <option key={method} value={method}>
                  {SHIPPING_METHOD_LABELS[method]}
                </option>
              ))}
            </select>
          </Field>

          <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Placing order…' : `Pay ${money(pkg.priceCents)}`}
          </button>
          <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
            Payment is simulated in this environment. No card is charged.
          </p>
        </form>

        <div className="card stack">
          <div>
            <div className="card-title">Order summary</div>
            <h3>{pkg.name}</h3>
          </div>
          <div className="spread">
            <span className="muted">Kits included</span>
            <strong>{pkg.kitCount}</strong>
          </div>
          <div className="spread">
            <span className="muted">Clinician review</span>
            <strong>{pkg.requiresClinician ? 'Yes' : 'Not required'}</strong>
          </div>
          <div className="spread" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <span className="muted">Total</span>
            <span className="price">{money(pkg.priceCents)}</span>
          </div>
        </div>
      </div>
    </>
  );
}
