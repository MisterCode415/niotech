import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Alert, Loading, StatusBadge, AddressBlock } from '../components/ui';

interface ScanResult {
  businessUnit: { slug: string; name: string };
  role: string;
  kit: {
    id: string;
    number: number;
    status: string;
    testTypeName: string;
    sampleType: string;
    externalKitId: string | null;
  };
  order: {
    id: string;
    orderNumber: string;
    status: string;
    packageName: string;
    externalFulfillmentId: string | null;
    patientName: string | null;
  };
  labReturnLabel: {
    labName: string;
    address: Parameters<typeof AddressBlock>[0]['address'];
    reference: string;
  } | null;
  actions: Array<{ id: string; label: string; method: 'POST'; path: string }>;
}

/**
 * One QR code, scanned by whoever is holding the kit. The server decides what this person is
 * allowed to do with it at this point in the workflow; the page just renders those choices.
 */
export function ScanPage() {
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['scan', token],
    queryFn: () => api<ScanResult>(`/api/scan/${token}`),
    retry: false,
  });

  const perform = useMutation({
    mutationFn: (path: string) => api(path, { method: 'POST' }),
    onSuccess: () => {
      setMessage('Done. The order has been updated.');
      void queryClient.invalidateQueries({ queryKey: ['scan', token] });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  if (isLoading) return <Loading what="kit" />;
  if (error) {
    return (
      <Alert tone="error">
        {error instanceof Error ? error.message : 'That code could not be read.'}
      </Alert>
    );
  }
  if (!data) return null;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="card-title">{data.businessUnit.name}</div>
          <h1>
            Kit {data.kit.number} · {data.kit.testTypeName}
          </h1>
          <p className="mono">
            {data.order.orderNumber}
            {data.order.externalFulfillmentId ? ` · REF ${data.order.externalFulfillmentId}` : ''}
          </p>
        </div>
        <StatusBadge status={data.kit.status} kind="kit" />
      </div>

      {message ? <Alert tone={perform.isError ? 'error' : 'success'}>{message}</Alert> : null}

      <div className="grid cols-2">
        <div className="card stack">
          <div>
            <div className="card-title">What you can do</div>
            {data.actions.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                Nothing is required from you for this kit right now.
              </p>
            ) : (
              <div className="stack">
                {data.actions.map((action) => (
                  <button
                    key={action.id}
                    className="primary"
                    disabled={perform.isPending}
                    onClick={() => perform.mutate(action.path)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="spread small">
            <span className="muted">Order status</span>
            <StatusBadge status={data.order.status} />
          </div>
          <div className="spread small">
            <span className="muted">Package</span>
            <span>{data.order.packageName}</span>
          </div>
          {data.order.patientName ? (
            <div className="spread small">
              <span className="muted">Patient</span>
              <span>{data.order.patientName}</span>
            </div>
          ) : null}

          <Link
            className="btn small"
            to={
              data.role === 'patient'
                ? `/portal/orders/${data.order.id}`
                : data.role === 'lab'
                  ? `/portal/lab/orders/${data.order.id}`
                  : `/portal/fulfillment/orders/${data.order.id}`
            }
          >
            Open full order
          </Link>
        </div>

        {data.labReturnLabel ? (
          <div className="card">
            <div className="card-title">Return label — mail your sample here</div>
            <h3>{data.labReturnLabel.labName}</h3>
            <AddressBlock address={data.labReturnLabel.address} />
            <div className="small muted" style={{ marginTop: 10 }}>
              Reference <span className="mono">{data.labReturnLabel.reference}</span>. This label
              ships inside your kit; the address is already filled in for you.
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
