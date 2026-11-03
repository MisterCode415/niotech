import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BusinessUnitBrand } from '@nio/shared';
import { api } from '../../lib/api';
import { Alert, Field, Loading } from '../../components/ui';
import { DnsInstructions, type DomainRow } from '../platform/PlatformDomains';

const STATUS_TONE = { verified: 'success', pending: 'pending', disabled: 'danger' } as const;

export function AdminBranding() {
  const { slug = '' } = useParams();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ displayName: '', logoUrl: '', primaryColor: '' });
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  const brand = useQuery({
    queryKey: ['admin', slug, 'brand'],
    queryFn: () => api<{ brand: BusinessUnitBrand }>(`/api/bu/${slug}/brand`),
  });
  const domains = useQuery({
    queryKey: ['admin', slug, 'domains'],
    queryFn: () => api<{ domains: DomainRow[] }>(`/api/bu/${slug}/domains`),
  });

  useEffect(() => {
    if (brand.data) {
      setForm({
        displayName: brand.data.brand.displayName ?? '',
        logoUrl: brand.data.brand.logoUrl ?? '',
        primaryColor: brand.data.brand.primaryColor ?? '',
      });
    }
  }, [brand.data]);

  const save = useMutation({
    mutationFn: () =>
      api<{ brand: BusinessUnitBrand }>(`/api/bu/${slug}/brand`, {
        method: 'PUT',
        // Empty fields are omitted so they fall back to the platform defaults.
        body: Object.fromEntries(
          Object.entries(form)
            .map(([key, value]) => [key, value.trim()])
            .filter(([, value]) => value),
        ),
      }),
    onSuccess: () => {
      setIsError(false);
      setMessage('Branding saved.');
      // The theme, title and logo are read through these keys on every public page.
      void queryClient.invalidateQueries({ queryKey: ['admin', slug, 'brand'] });
      void queryClient.invalidateQueries({ queryKey: ['public', slug] });
      void queryClient.invalidateQueries({ queryKey: ['host'] });
    },
    onError: (err: Error) => {
      setIsError(true);
      setMessage(err.message);
    },
  });

  if (brand.isLoading) return <Loading what="branding" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Branding</h1>
          <p>
            How your storefront, checkout, and patient portal present themselves. Anything you
            leave blank uses the platform default.
          </p>
        </div>
      </div>

      <Alert tone={isError ? 'error' : 'success'}>{message}</Alert>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">Brand</div>
          <Field label="Display name" hint="Shown in the header and browser tab.">
            <input
              value={form.displayName}
              maxLength={80}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </Field>
          <Field label="Logo URL" hint="An https:// link to a PNG, SVG, or JPG; about 180×32 shows best.">
            <input
              value={form.logoUrl}
              onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
              placeholder="https://your-clinic.com/logo.svg"
            />
          </Field>
          <Field label="Primary color" hint="Buttons, links, and highlights. Six-digit hex.">
            <div className="row">
              <input
                type="color"
                aria-label="Pick a color"
                value={/^#[0-9a-fA-F]{6}$/.test(form.primaryColor) ? form.primaryColor : '#4f9cf9'}
                onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                style={{ width: 56, padding: 2 }}
              />
              <input
                value={form.primaryColor}
                onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                placeholder="#0f766e"
              />
            </div>
          </Field>
          <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save branding'}
          </button>
        </div>

        <div className="card">
          <div className="card-title">Your domains</div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Want your storefront and portal on your own address, such as{' '}
            <span className="mono">order.your-clinic.com</span>? Ask the platform team to connect
            it, then publish the DNS records they give you.
          </p>
          {domains.isLoading ? <Loading what="domains" /> : null}
          {(domains.data?.domains.length ?? 0) === 0 && !domains.isLoading ? (
            <p className="small muted">No custom domains connected.</p>
          ) : (
            domains.data?.domains.map((domain) => (
              <div key={domain.id} style={{ marginBottom: 14 }}>
                <strong className="mono">{domain.hostname}</strong>{' '}
                <span className={`badge ${STATUS_TONE[domain.status]}`}>{domain.status}</span>
                {domain.isPrimary ? (
                  <span className="badge active" style={{ marginLeft: 6 }}>
                    primary
                  </span>
                ) : null}
                {domain.status !== 'verified' ? <DnsInstructions domain={domain} /> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
