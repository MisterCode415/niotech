import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { canTransition, type OrderStatus } from '@nio/shared';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { MockBadge, Loading, Empty, StatusBadge, Alert, Field } from '../../components/ui';

interface OrderRow {
  id: string;
  orderNumber: string;
  isMock?: boolean;
  status: string;
  createdAt: string;
  patientName: string;
  packageName: string;
  requiresClinician: boolean;
}

interface EmailResult {
  recorded: number;
  emailed: number;
  emailFailures: number;
}

function cancellable(status: string) {
  return canTransition(status as OrderStatus, 'cancelled', 'bu_admin');
}

export function AdminOrders() {
  const { slug = '' } = useParams();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [correctionNote, setCorrectionNote] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', slug, 'orders'],
    queryFn: () => api<{ orders: OrderRow[] }>(`/api/bu/${slug}/orders`),
  });

  const selected = data?.orders.find((order) => order.id === selectedId) ?? null;

  function done(text: string, email?: EmailResult) {
    setError('');
    setNotice(
      email?.emailFailures
        ? `${text} The email could not be delivered. Check SMTP or Mailpit.`
        : text,
    );
    void queryClient.invalidateQueries({ queryKey: ['admin', slug, 'orders'] });
  }

  const cancel = useMutation({
    mutationFn: () =>
      api<{ email?: EmailResult }>(`/api/bu/${slug}/orders/${selectedId}/cancel`, {
        method: 'POST',
        body: { reason: cancelReason },
      }),
    onSuccess: (result) => {
      setCancelReason('');
      done('Order cancelled. The patient was notified.', result.email);
    },
    onError: (err: Error) => {
      setNotice('');
      setError(err.message);
    },
  });

  const correct = useMutation({
    mutationFn: () =>
      api<{ email?: EmailResult }>(`/api/bu/${slug}/orders/${selectedId}/corrections`, {
        method: 'POST',
        body: { note: correctionNote },
      }),
    onSuccess: (result) => {
      setCorrectionNote('');
      done('Correction sent to the patient.', result.email);
    },
    onError: (err: Error) => {
      setNotice('');
      setError(err.message);
    },
  });

  if (isLoading) return <Loading what="orders" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Orders</h1>
          <p>Every order placed with your business unit, wherever it currently sits.</p>
        </div>
      </div>

      <Alert tone="success">{notice}</Alert>
      <Alert tone="error">{error}</Alert>

      {(data?.orders.length ?? 0) === 0 ? (
        <Empty>No orders yet.</Empty>
      ) : (
        <div className="grid cols-2">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Patient</th>
                  <th>Package</th>
                  <th>Placed</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data!.orders.map((order) => (
                  <tr
                    key={order.id}
                    onClick={() => setSelectedId(order.id)}
                    style={{
                      cursor: 'pointer',
                      background: order.id === selectedId ? 'var(--row-active, #eef4ff)' : undefined,
                    }}
                  >
                    <td className="mono">
                      {order.orderNumber} <MockBadge show={order.isMock} />
                    </td>
                    <td>{order.patientName}</td>
                    <td>
                      {order.packageName}
                      {order.requiresClinician ? (
                        <>
                          {' '}
                          <span className="pill">clinician</span>
                        </>
                      ) : null}
                    </td>
                    <td className="muted">{date(order.createdAt)}</td>
                    <td>
                      <StatusBadge status={order.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="card-title">Reconcile</div>
            {!selected ? (
              <p className="small muted" style={{ margin: 0 }}>
                Select an order to cancel it or send a correction email.
              </p>
            ) : (
              <>
                <p>
                  <strong className="mono">{selected.orderNumber}</strong>{' '}
                  <StatusBadge status={selected.status} />
                </p>
                <Field label="Cancellation reason">
                  <textarea
                    value={cancelReason}
                    onChange={(event) => setCancelReason(event.target.value)}
                    placeholder="Why is this order being cancelled?"
                    disabled={!cancellable(selected.status)}
                  />
                </Field>
                <button
                  className="danger"
                  onClick={() => cancel.mutate()}
                  disabled={
                    !cancellable(selected.status) || !cancelReason.trim() || cancel.isPending
                  }
                >
                  Cancel order
                </button>
                {!cancellable(selected.status) ? (
                  <p className="small muted">This order can no longer be cancelled.</p>
                ) : null}

                <Field label="Correction note" hint="Becomes the body of a follow-up email.">
                  <textarea
                    value={correctionNote}
                    onChange={(event) => setCorrectionNote(event.target.value)}
                    placeholder="What should the patient know?"
                  />
                </Field>
                <button
                  onClick={() => correct.mutate()}
                  disabled={!correctionNote.trim() || correct.isPending}
                >
                  Send correction
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
