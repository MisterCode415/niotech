import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ORDER_ISSUE_REASONS, ORDER_ISSUE_REASON_LABELS } from '@nio/shared';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import {
  Loading,
  StatusBadge,
  Timeline,
  AddressBlock,
  Alert,
  Field,
  type TimelineEvent,
} from '../../components/ui';
import { QrSticker } from '../../components/QrSticker';

interface Detail {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    shippingAddress: Parameters<typeof AddressBlock>[0]['address'];
    shippingMethod: string;
    externalFulfillmentId: string | null;
    patientName: string;
    packageName: string;
  };
  kits: Array<{
    id: string;
    kitNumber: number;
    status: string;
    testTypeName: string;
    qrPayload: string;
  }>;
  shipments: Array<{
    direction: string;
    carrier: string | null;
    trackingNumber: string | null;
    shippedAt: string | null;
  }>;
  events: TimelineEvent[];
  issues: Array<{ id: string; reason: string; detail: string | null; status: string; createdAt: string }>;
}

export function FulfillmentOrder() {
  const { orderId = '' } = useParams();
  const { me } = useAuth();
  const queryClient = useQueryClient();

  const slug = me?.memberships.find((m) => m.role === 'fulfillment')?.businessUnitSlug;
  const base = `/api/bu/${slug}/fulfillment/orders/${orderId}`;

  const [externalId, setExternalId] = useState('');
  const [carrier, setCarrier] = useState('UPS');
  const [tracking, setTracking] = useState('');
  const [issueReason, setIssueReason] = useState<string>('address_invalid');
  const [issueDetail, setIssueDetail] = useState('');
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['fulfillment', 'order', orderId],
    queryFn: () => api<Detail>(base),
    enabled: Boolean(slug),
  });

  useEffect(() => {
    if (data?.order.externalFulfillmentId) setExternalId(data.order.externalFulfillmentId);
  }, [data?.order.externalFulfillmentId]);

  function onError(err: Error) {
    setError(err.message);
  }
  function onDone() {
    setError('');
    void queryClient.invalidateQueries({ queryKey: ['fulfillment'] });
  }

  const correlate = useMutation({
    mutationFn: () => api(`${base}/correlate`, { method: 'POST', body: { externalOrderId: externalId } }),
    onSuccess: onDone,
    onError,
  });

  const label = useMutation({
    mutationFn: () => api(`${base}/label`, { method: 'POST' }),
    onSuccess: onDone,
    onError,
  });

  const ship = useMutation({
    mutationFn: () =>
      api(`${base}/ship`, { method: 'POST', body: { carrier, trackingNumber: tracking } }),
    onSuccess: onDone,
    onError,
  });

  const flag = useMutation({
    mutationFn: () =>
      api(`${base}/issues`, { method: 'POST', body: { reason: issueReason, detail: issueDetail } }),
    onSuccess: () => {
      setIssueDetail('');
      onDone();
    },
    onError,
  });

  if (isLoading || !data) return <Loading what="order" />;

  const awaitingShipment = data.order.status === 'dispatched_to_fulfillment';
  const outbound = data.shipments.find((s) => s.direction === 'outbound_to_patient');

  return (
    <>
      <div className="page-header no-print">
        <div>
          <Link to="/portal/fulfillment" className="small muted">
            ← Queue
          </Link>
          <h1 style={{ marginTop: 8 }}>{data.order.orderNumber}</h1>
          <p>
            {data.order.packageName} for {data.order.patientName}
          </p>
        </div>
        <StatusBadge status={data.order.status} />
      </div>

      <div className="no-print">
        <Alert tone="error">{error}</Alert>
      </div>

      <div className="grid cols-2 no-print" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-title">Ship to</div>
          <AddressBlock address={data.order.shippingAddress} />
          <div className="spread small" style={{ marginTop: 12 }}>
            <span className="muted">Service</span>
            <strong>{data.order.shippingMethod}</strong>
          </div>
          <div className="spread small">
            <span className="muted">Kits to send</span>
            <strong>{data.kits.length}</strong>
          </div>
          {outbound?.trackingNumber ? (
            <div className="spread small">
              <span className="muted">Tracking</span>
              <span className="mono">
                {outbound.carrier} {outbound.trackingNumber}
              </span>
            </div>
          ) : null}
        </div>

        <div className="card">
          <div className="card-title">Your order reference</div>
          <p className="small muted">
            Record your own order id so both systems point at the same shipment.
          </p>
          <div className="row">
            <input
              value={externalId}
              onChange={(event) => setExternalId(event.target.value)}
              placeholder="e.g. WH-100482"
            />
            <button onClick={() => correlate.mutate()} disabled={!externalId || correlate.isPending}>
              Save
            </button>
          </div>
        </div>
      </div>

      <div className="card no-print" style={{ marginBottom: 20 }}>
        <div className="spread" style={{ marginBottom: 12 }}>
          <div className="card-title" style={{ margin: 0 }}>
            Kit labels
          </div>
          <div className="row">
            <button onClick={() => label.mutate()} disabled={label.isPending}>
              Mark labels applied
            </button>
            <button className="primary" onClick={() => window.print()}>
              Print sticker sheet
            </button>
          </div>
        </div>
        <p className="small muted">
          Each sticker carries the scannable code plus both order references, and stays with the kit
          all the way to the lab.
        </p>
      </div>

      <div className="sticker-sheet" style={{ marginBottom: 20 }}>
        {data.kits.map((kit) => (
          <QrSticker
            key={kit.id}
            value={kit.qrPayload}
            orderNumber={data.order.orderNumber}
            externalOrderId={data.order.externalFulfillmentId}
            kitNumber={kit.kitNumber}
            testTypeName={kit.testTypeName}
          />
        ))}
      </div>

      <div className="grid cols-2 no-print">
        <div className="stack">
          <div className="card">
            <div className="card-title">Mark as shipped</div>
            {awaitingShipment ? (
              <>
                <div className="field-row">
                  <Field label="Carrier">
                    <input value={carrier} onChange={(event) => setCarrier(event.target.value)} />
                  </Field>
                  <Field label="Tracking number">
                    <input value={tracking} onChange={(event) => setTracking(event.target.value)} />
                  </Field>
                </div>
                <button
                  className="primary"
                  onClick={() => ship.mutate()}
                  disabled={!tracking || ship.isPending}
                >
                  Ship order
                </button>
              </>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                This order has already left the warehouse.
              </p>
            )}
          </div>

          <div className="card">
            <div className="card-title">Flag a problem</div>
            <Field label="Reason">
              <select value={issueReason} onChange={(event) => setIssueReason(event.target.value)}>
                {ORDER_ISSUE_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {ORDER_ISSUE_REASON_LABELS[reason]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Detail">
              <textarea
                value={issueDetail}
                onChange={(event) => setIssueDetail(event.target.value)}
                placeholder="What went wrong?"
              />
            </Field>
            <button className="danger" onClick={() => flag.mutate()} disabled={flag.isPending}>
              Flag issue
            </button>

            {data.issues.length > 0 ? (
              <div style={{ marginTop: 14 }}>
                {data.issues.map((issue) => (
                  <div key={issue.id} className="small" style={{ marginBottom: 6 }}>
                    <span className="badge danger">
                      {ORDER_ISSUE_REASON_LABELS[issue.reason as keyof typeof ORDER_ISSUE_REASON_LABELS]}
                    </span>{' '}
                    <span className="muted">{date(issue.createdAt)}</span>
                    {issue.detail ? <div className="muted">{issue.detail}</div> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Order history</div>
          <Timeline events={data.events} />
        </div>
      </div>
    </>
  );
}
