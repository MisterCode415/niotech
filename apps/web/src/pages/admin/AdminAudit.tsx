import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, fetchBlobUrl } from '../../lib/api';
import { Alert, Empty, Field, Loading } from '../../components/ui';
import { date } from '../../lib/format';

interface DisclosureEntry {
  at: string;
  source: 'phi_access' | 'order_event' | 'conversation';
  orderId: string | null;
  actorEmail: string | null;
  actorRole: string;
  actingPlatformAdmin: boolean;
  resource: string;
  action: string;
  detail: string;
  requestId: string | null;
  ip: string | null;
}

interface DisclosureResult {
  entries: DisclosureEntry[];
  truncated: boolean;
  orderCount: number;
}

interface Filters {
  patientEmail: string;
  orderId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { patientEmail: '', orderId: '', from: '', to: '' };

function queryString(filters: Filters, format: 'json' | 'csv'): string {
  const params = new URLSearchParams({ format });
  if (filters.orderId.trim()) params.set('orderId', filters.orderId.trim());
  else if (filters.patientEmail.trim()) params.set('patientEmail', filters.patientEmail.trim());
  // Date inputs are whole days: include the full end day.
  if (filters.from) params.set('from', new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) params.set('to', new Date(`${filters.to}T23:59:59.999`).toISOString());
  return params.toString();
}

export function AdminAudit() {
  const { slug = '' } = useParams();
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters | null>(null);
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);

  const result = useQuery({
    queryKey: ['admin', slug, 'audit', applied],
    enabled: applied !== null,
    // Every lookup is itself recorded in the audit trail, so never refetch behind the user's back.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: () =>
      api<DisclosureResult>(`/api/bu/${slug}/audit/disclosures?${queryString(applied!, 'json')}`),
  });

  function search(event: FormEvent) {
    event.preventDefault();
    setDownloadError('');
    setApplied({ ...draft });
  }

  async function download() {
    if (!applied) return;
    setDownloading(true);
    setDownloadError('');
    try {
      const url = await fetchBlobUrl(
        `/api/bu/${slug}/audit/disclosures?${queryString(applied, 'csv')}`,
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `disclosures-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  const canSearch = Boolean(draft.patientEmail.trim() || draft.orderId.trim());

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Accounting of disclosures</h1>
          <p>
            Who opened a patient&apos;s health information, and what happened to their orders. Every
            lookup and export here is itself recorded.
          </p>
        </div>
      </div>

      <form className="card" onSubmit={search}>
        <div className="grid cols-2">
          <Field label="Patient email">
            <input
              type="email"
              value={draft.patientEmail}
              onChange={(event) => setDraft({ ...draft, patientEmail: event.target.value })}
            />
          </Field>
          <Field label="Order ID" hint="Overrides the patient email when both are filled in.">
            <input
              value={draft.orderId}
              onChange={(event) => setDraft({ ...draft, orderId: event.target.value })}
            />
          </Field>
          <Field label="From">
            <input
              type="date"
              value={draft.from}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={draft.to}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            />
          </Field>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" type="submit" disabled={!canSearch}>
            Look up
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => void download()}
            disabled={!applied || downloading}
          >
            {downloading ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
      </form>

      <Alert tone="error">{downloadError || (result.error ? result.error.message : '')}</Alert>
      {result.isFetching ? <Loading what="disclosures" /> : null}

      {result.data && !result.isFetching ? (
        <div className="card">
          <div className="card-title">
            {result.data.entries.length} entries across {result.data.orderCount}{' '}
            {result.data.orderCount === 1 ? 'order' : 'orders'}
          </div>
          {result.data.truncated ? (
            <Alert tone="info">
              This result was cut off at the per-source limit. Narrow the date range for the rest.
            </Alert>
          ) : null}
          {result.data.entries.length === 0 ? (
            <Empty>No recorded activity for this lookup.</Empty>
          ) : (
            <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {result.data.entries.map((entry, index) => (
                  <tr key={`${entry.at}-${index}`}>
                    <td>{date(entry.at)}</td>
                    <td>
                      {entry.actorEmail ?? 'system'}
                      <div className="small muted">
                        {entry.actorRole}
                        {entry.actingPlatformAdmin ? ' (platform admin acting as)' : ''}
                      </div>
                    </td>
                    <td>
                      {entry.resource} · {entry.action}
                    </td>
                    <td className="small">
                      {entry.detail}
                      {entry.ip ? <div className="muted">IP {entry.ip}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
