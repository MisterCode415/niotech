import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fetchBlobUrl } from '../../lib/api';
import { money, date, bytes } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import {
  Loading,
  Empty,
  StatusBadge,
  Timeline,
  AddressBlock,
  Alert,
  type TimelineEvent,
} from '../../components/ui';

interface Detail {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    priceCents: number;
    shippingAddress: Parameters<typeof AddressBlock>[0]['address'];
    shippingMethod: string;
    requiresClinician: boolean;
    packageName: string;
    resultsReleasedAt: string | null;
  };
  kits: Array<{
    id: string;
    kitNumber: number;
    status: string;
    testTypeName: string;
    sampleType: string;
  }>;
  shipments: Array<{
    direction: string;
    carrier: string | null;
    trackingNumber: string | null;
    shippedAt: string | null;
  }>;
  events: TimelineEvent[];
  results: Array<{ id: string; fileId: string | null; filename: string | null; sizeBytes: number | null; summary: string | null }>;
  review: {
    decision: string | null;
    interpretation: string | null;
    recommendations: string | null;
    doctorName: string | null;
    decidedAt: string | null;
  } | null;
}

export function PatientOrderDetail() {
  const { orderId = '' } = useParams();
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState('');

  const slug = me?.memberships.find((m) => m.role === 'patient')?.businessUnitSlug;
  const base = `/api/bu/${slug}/patient/orders/${orderId}`;

  const { data, isLoading } = useQuery({
    queryKey: ['patient', 'order', orderId],
    queryFn: () => api<Detail>(base),
    enabled: Boolean(slug),
  });

  const act = useMutation({
    mutationFn: ({ kitId, action }: { kitId: string; action: 'received' | 'sent-to-lab' }) =>
      api(`${base}/kits/${kitId}/${action}`, { method: 'POST' }),
    onSuccess: () => {
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['patient'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  if (isLoading || !data) return <Loading what="order" />;

  const outbound = data.shipments.find((s) => s.direction === 'outbound_to_patient');
  const released = data.order.status === 'results_released';

  return (
    <>
      <div className="page-header">
        <div>
          <Link to="/portal/orders" className="small muted">
            ← All orders
          </Link>
          <h1 style={{ marginTop: 8 }}>{data.order.packageName}</h1>
          <p className="mono">{data.order.orderNumber}</p>
        </div>
        <StatusBadge status={data.order.status} />
      </div>

      <Alert tone="error">{error}</Alert>

      <div className="grid cols-2">
        <div className="stack">
          <div className="card">
            <div className="card-title">Your kits</div>
            {data.kits.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                Kits are created once payment clears.
              </p>
            ) : (
              <div className="stack">
                {data.kits.map((kit) => (
                  <div key={kit.id} className="kit-card">
                    <div className="spread">
                      <div>
                        <strong>
                          Kit {kit.kitNumber} · {kit.testTypeName}
                        </strong>
                        <div className="small muted">{kit.sampleType} sample</div>
                      </div>
                      <StatusBadge status={kit.status} kind="kit" />
                    </div>

                    {kit.status === 'shipped' ? (
                      <button
                        className="primary small"
                        style={{ marginTop: 10 }}
                        disabled={act.isPending}
                        onClick={() => act.mutate({ kitId: kit.id, action: 'received' })}
                      >
                        I received this kit
                      </button>
                    ) : null}

                    {kit.status === 'received_by_patient' ? (
                      <button
                        className="primary small"
                        style={{ marginTop: 10 }}
                        disabled={act.isPending}
                        onClick={() => act.mutate({ kitId: kit.id, action: 'sent-to-lab' })}
                      >
                        I mailed my sample
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title">Results</div>
            {!released ? (
              <p className="muted small" style={{ margin: 0 }}>
                {data.order.requiresClinician
                  ? 'Your results will appear here once a doctor has reviewed them.'
                  : 'Your results will appear here once the lab finishes.'}
              </p>
            ) : (
              <>
                {data.review ? (
                  <div style={{ marginBottom: 14 }}>
                    <div className="spread">
                      <strong>Doctor's interpretation</strong>
                      <span className={`badge ${data.review.decision === 'approved' ? 'success' : 'danger'}`}>
                        {data.review.decision === 'approved' ? 'Approved' : 'Not approved'}
                      </span>
                    </div>
                    <p className="small" style={{ whiteSpace: 'pre-wrap' }}>
                      {data.review.interpretation}
                    </p>
                    {data.review.recommendations ? (
                      <>
                        <strong className="small">Recommendations</strong>
                        <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>
                          {data.review.recommendations}
                        </p>
                      </>
                    ) : null}
                    <div className="small muted">
                      {data.review.doctorName} · {date(data.review.decidedAt)}
                    </div>
                  </div>
                ) : null}

                {data.results.map((result) =>
                  result.fileId ? (
                    <button
                      key={result.id}
                      className="small"
                      onClick={async () => {
                        const url = await fetchBlobUrl(`${base}/results/${result.fileId}`);
                        window.open(url, '_blank', 'noopener');
                      }}
                    >
                      Open {result.filename} ({bytes(result.sizeBytes ?? 0)})
                    </button>
                  ) : null,
                )}
              </>
            )}
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-title">Shipping</div>
            <AddressBlock address={data.order.shippingAddress} />
            <div className="spread small" style={{ marginTop: 12 }}>
              <span className="muted">Method</span>
              <span>{data.order.shippingMethod}</span>
            </div>
            {outbound?.trackingNumber ? (
              <div className="spread small">
                <span className="muted">Tracking</span>
                <span className="mono">
                  {outbound.carrier} {outbound.trackingNumber}
                </span>
              </div>
            ) : null}
            <div className="spread small">
              <span className="muted">Paid</span>
              <span>{money(data.order.priceCents)}</span>
            </div>
          </div>

          <div className="card">
            <div className="card-title">Progress</div>
            <Timeline events={data.events} />
          </div>
        </div>
      </div>

      {data.kits.length === 0 && data.events.length === 0 ? <Empty>Nothing here yet.</Empty> : null}
    </>
  );
}
