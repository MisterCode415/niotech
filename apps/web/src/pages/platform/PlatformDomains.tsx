import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DomainStatus } from '@nio/shared';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { Alert, Empty, Field, Loading } from '../../components/ui';

interface BusinessUnitRow {
  id: string;
  name: string;
  slug: string;
}

export interface DomainRow {
  id: string;
  hostname: string;
  status: DomainStatus;
  isPrimary: boolean;
  verifiedAt: string | null;
  lastCheckAt: string | null;
  lastCheckError: string | null;
  dns: { txtName: string; txtValue: string; target: string };
}

const STATUS_TONE: Record<DomainStatus, string> = {
  verified: 'success',
  pending: 'pending',
  disabled: 'danger',
};

/** The two records a tenant has to publish; shared with the tenant-facing read-only view. */
export function DnsInstructions({ domain }: { domain: DomainRow }) {
  return (
    <div className="small" style={{ marginTop: 8 }}>
      <div>
        <strong>1. Prove ownership</strong> — add a TXT record:
      </div>
      <div className="mono" style={{ margin: '4px 0 10px', wordBreak: 'break-all' }}>
        {domain.dns.txtName} → {domain.dns.txtValue}
      </div>
      <div>
        <strong>2. Route traffic</strong> — point the hostname at us (CNAME, or ALIAS/ANAME for a
        root domain):
      </div>
      <div className="mono" style={{ marginTop: 4 }}>
        {domain.hostname} → {domain.dns.target}
      </div>
    </div>
  );
}

export function PlatformDomains() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState('');
  const [hostname, setHostname] = useState('');
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  const units = useQuery({
    queryKey: ['platform', 'business-units'],
    queryFn: () => api<{ businessUnits: BusinessUnitRow[] }>('/api/platform/business-units'),
  });

  const domains = useQuery({
    queryKey: ['platform', 'domains', selected],
    queryFn: () =>
      api<{ domains: DomainRow[] }>(`/api/platform/business-units/${selected}/domains`),
    enabled: Boolean(selected),
  });

  function done(text: string, tone: 'ok' | 'error' = 'ok') {
    setIsError(tone === 'error');
    setMessage(text);
    void queryClient.invalidateQueries({ queryKey: ['platform', 'domains', selected] });
  }
  const fail = (err: Error) => done(err.message, 'error');

  const add = useMutation({
    mutationFn: () =>
      api(`/api/platform/business-units/${selected}/domains`, {
        method: 'POST',
        body: { hostname },
      }),
    onSuccess: () => {
      setHostname('');
      done('Domain added. Publish the DNS records below, then check them.');
    },
    onError: fail,
  });

  const verify = useMutation({
    mutationFn: (id: string) =>
      api<{
        domain: DomainRow;
        check: { verified: boolean; error: string | null; routed: boolean };
        identityProviderError: string | null;
      }>(`/api/platform/domains/${id}/verify`, { method: 'POST' }),
    onSuccess: (result) => {
      if (!result.check.verified) {
        done(result.check.error ?? 'DNS check failed.', 'error');
      } else if (result.identityProviderError) {
        done(
          `${result.domain.hostname} is verified, but ${result.identityProviderError.toLowerCase()}. ` +
            'Sign-in from this domain will fail until that is fixed; check again to retry.',
          'error',
        );
      } else if (!result.check.routed) {
        done(
          `${result.domain.hostname} is verified. It does not point at the platform yet, so ` +
            'visitors will not reach it until the CNAME is published.',
        );
      } else {
        done(`${result.domain.hostname} is live.`);
      }
    },
    onError: fail,
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'primary' | 'disable' | 'delete' }) =>
      action === 'delete'
        ? api(`/api/platform/domains/${id}`, { method: 'DELETE' })
        : api(`/api/platform/domains/${id}/${action}`, { method: 'POST' }),
    onSuccess: (_result, { action }) =>
      done(
        action === 'primary'
          ? 'Primary domain updated.'
          : action === 'disable'
            ? 'Domain disabled.'
            : 'Domain removed.',
      ),
    onError: fail,
  });

  if (units.isLoading) return <Loading what="business units" />;

  return (
    <>
      <div className="page-header">
        <div>
          <Link to="/portal/platform" className="small muted">
            ← Platform
          </Link>
          <h1 style={{ marginTop: 8 }}>Custom domains</h1>
          <p>
            Connect a tenant's own hostname. A domain only serves traffic, and only gets a TLS
            certificate, once its TXT record proves the tenant controls it.
          </p>
        </div>
      </div>

      <Alert tone={isError ? 'error' : 'success'}>{message}</Alert>

      <div className="card" style={{ marginBottom: 22 }}>
        <Field label="Business unit">
          <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="">Choose a business unit…</option>
            {units.data?.businessUnits.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name} (/{unit.slug})
              </option>
            ))}
          </select>
        </Field>

        {selected ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate();
            }}
          >
            <Field label="Hostname" hint="For example order.your-clinic.com — no https:// or path.">
              <input
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder="order.your-clinic.com"
              />
            </Field>
            <button className="primary" type="submit" disabled={add.isPending || !hostname.trim()}>
              {add.isPending ? 'Adding…' : 'Add domain'}
            </button>
          </form>
        ) : null}
      </div>

      {selected && domains.isLoading ? <Loading what="domains" /> : null}
      {selected && domains.data ? (
        domains.data.domains.length === 0 ? (
          <Empty>No custom domains for this business unit yet.</Empty>
        ) : (
          <div className="stack">
            {domains.data.domains.map((domain) => (
              <div key={domain.id} className="card">
                <div className="spread">
                  <div>
                    <strong className="mono">{domain.hostname}</strong>{' '}
                    <span className={`badge ${STATUS_TONE[domain.status]}`}>{domain.status}</span>
                    {domain.isPrimary ? (
                      <span className="badge active" style={{ marginLeft: 6 }}>
                        primary
                      </span>
                    ) : null}
                    <div className="small muted">
                      {domain.verifiedAt
                        ? `Verified ${date(domain.verifiedAt)}`
                        : domain.lastCheckAt
                          ? `Last checked ${date(domain.lastCheckAt)}`
                          : 'Not checked yet'}
                    </div>
                    {domain.lastCheckError && domain.status !== 'verified' ? (
                      <div className="small" style={{ color: 'var(--danger)' }}>
                        {domain.lastCheckError}
                      </div>
                    ) : null}
                  </div>
                  <div className="role-chips">
                    <button
                      className="small"
                      disabled={verify.isPending}
                      onClick={() => verify.mutate(domain.id)}
                    >
                      {domain.status === 'verified' ? 'Re-check' : 'Check DNS'}
                    </button>
                    {domain.status === 'verified' && !domain.isPrimary ? (
                      <button
                        className="small"
                        onClick={() => act.mutate({ id: domain.id, action: 'primary' })}
                      >
                        Make primary
                      </button>
                    ) : null}
                    {domain.status !== 'disabled' ? (
                      <button
                        className="small"
                        onClick={() => act.mutate({ id: domain.id, action: 'disable' })}
                      >
                        Disable
                      </button>
                    ) : null}
                    <button
                      className="small"
                      onClick={() => {
                        if (window.confirm(`Remove ${domain.hostname}? Its links will stop working.`)) {
                          act.mutate({ id: domain.id, action: 'delete' });
                        }
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                {domain.status !== 'verified' ? <DnsInstructions domain={domain} /> : null}
              </div>
            ))}
          </div>
        )
      ) : null}
    </>
  );
}
