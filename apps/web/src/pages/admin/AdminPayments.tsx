import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { money } from '../../lib/format';
import { Alert, Empty, Loading } from '../../components/ui';

interface PaymentConfig {
  provider: string;
  account: {
    status: string;
    accountId: string | null;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    disabledReason: string | null;
    country: string | null;
    defaultCurrency: string | null;
    lastSyncError: string | null;
  } | null;
  dashboardUrl: string | null;
  mappings: Array<{
    packageId: string;
    packageName: string;
    packageVersion: number;
    packageStatus: string;
    syncStatus: string | null;
    productId: string | null;
    priceId: string | null;
    error: string | null;
  }>;
}

interface PaymentRow {
  id: string;
  orderId: string;
  orderNumber: string;
  status: string;
  amountCents: number;
  refundedCents: number;
  disputedCents: number;
  currency: string;
  paymentIntentId: string | null;
  failureMessage: string | null;
}

export function AdminPayments() {
  const { slug = '' } = useParams();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const config = useQuery({
    queryKey: ['admin', slug, 'payments-config'],
    queryFn: () => api<PaymentConfig>(`/api/bu/${slug}/payments/config`),
  });
  const ledger = useQuery({
    queryKey: ['admin', slug, 'payments'],
    queryFn: () => api<{ payments: PaymentRow[] }>(`/api/bu/${slug}/payments`),
  });

  function complete(text: string) {
    setError('');
    setMessage(text);
    void queryClient.invalidateQueries({ queryKey: ['admin', slug, 'payments-config'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', slug, 'payments'] });
  }
  function failed(reason: unknown) {
    setMessage('');
    setError(reason instanceof Error ? reason.message : 'Payment operation failed');
  }

  const connect = useMutation({
    mutationFn: () => api<{ url: string }>(`/api/bu/${slug}/payments/connect`, { method: 'POST' }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: failed,
  });
  const refresh = useMutation({
    mutationFn: () => api(`/api/bu/${slug}/payments/refresh`, { method: 'POST' }),
    onSuccess: () => complete('Stripe account status refreshed.'),
    onError: failed,
  });
  const disconnect = useMutation({
    mutationFn: () => api(`/api/bu/${slug}/payments/disconnect`, { method: 'POST' }),
    onSuccess: () => complete('Stripe account disconnected.'),
    onError: failed,
  });
  const sync = useMutation({
    mutationFn: (packageId: string) =>
      api(`/api/bu/${slug}/payments/packages/${packageId}/sync`, { method: 'POST' }),
    onSuccess: () => complete('Package synchronized with Stripe.'),
    onError: failed,
  });
  const refund = useMutation({
    mutationFn: (paymentId: string) =>
      api(`/api/bu/${slug}/payments/${paymentId}/refund`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: () => complete('Refund submitted. Stripe will confirm it by webhook.'),
    onError: failed,
  });
  const reconcile = useMutation({
    mutationFn: (paymentId: string) =>
      api(`/api/bu/${slug}/payments/${paymentId}/reconcile`, { method: 'POST' }),
    onSuccess: () => complete('Payment reconciled with Stripe.'),
    onError: failed,
  });

  if (config.isLoading || ledger.isLoading) return <Loading what="payments" />;
  if (config.isError || ledger.isError) return <Alert tone="error">Could not load payments.</Alert>;

  const account = config.data!.account;
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Payments</h1>
          <p>
            Connect this business to Stripe and manage catalog synchronization and transactions.
          </p>
        </div>
      </div>
      <Alert tone="success">{message}</Alert>
      <Alert tone="error">{error}</Alert>
      {config.data!.provider !== 'stripe' && (
        <Alert tone="error">
          Stripe is not enabled in this environment. Set PAYMENT_PROVIDER=stripe and the sandbox
          credentials on the API.
        </Alert>
      )}

      <div className="card" style={{ marginBottom: 22 }}>
        <div className="spread">
          <div>
            <div className="card-title">Stripe Connect</div>
            <h3>{account ? account.status : 'Not connected'}</h3>
            {account && (
              <p className="small muted">
                Charges {account.chargesEnabled ? 'enabled' : 'disabled'} · Payouts{' '}
                {account.payoutsEnabled ? 'enabled' : 'disabled'}
                {account.disabledReason ? ` · ${account.disabledReason}` : ''}
              </p>
            )}
          </div>
          <div>
            {!account?.accountId ? (
              <button
                className="primary"
                onClick={() => connect.mutate()}
                disabled={config.data!.provider !== 'stripe'}
              >
                Connect Stripe
              </button>
            ) : (
              <>
                <button onClick={() => refresh.mutate()}>Refresh status</button>
                {config.data!.dashboardUrl && (
                  <a
                    className="btn primary"
                    href={config.data!.dashboardUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ marginLeft: 8 }}
                  >
                    Open Stripe Dashboard
                  </a>
                )}
                <button
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                  style={{ marginLeft: 8 }}
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <h2>Catalog synchronization</h2>
      <div className="table-wrap" style={{ marginBottom: 22 }}>
        <table>
          <thead>
            <tr>
              <th>Package</th>
              <th>Qinio status</th>
              <th>Stripe status</th>
              <th>Stripe IDs</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {config.data!.mappings.map((mapping) => (
              <tr key={mapping.packageId}>
                <td>
                  {mapping.packageName} <span className="muted">v{mapping.packageVersion}</span>
                </td>
                <td>{mapping.packageStatus}</td>
                <td>
                  <span
                    className={`badge ${mapping.syncStatus === 'synced' ? 'active' : 'pending'}`}
                  >
                    {mapping.syncStatus ?? 'not queued'}
                  </span>
                  {mapping.error && <div className="small muted">{mapping.error}</div>}
                </td>
                <td className="small mono">
                  <div>{mapping.productId ?? '—'}</div>
                  <div>{mapping.priceId ?? '—'}</div>
                </td>
                <td>
                  <button onClick={() => sync.mutate(mapping.packageId)}>Sync</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Transactions</h2>
      {ledger.data!.payments.length === 0 ? (
        <Empty>No Stripe payments yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Refunded</th>
                <th>Disputed</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {ledger.data!.payments.map((payment) => (
                <tr key={payment.id}>
                  <td className="mono">{payment.orderNumber}</td>
                  <td>{money(payment.amountCents)}</td>
                  <td>{payment.status}</td>
                  <td>{money(payment.refundedCents)}</td>
                  <td>{money(payment.disputedCents)}</td>
                  <td>
                    <button
                      disabled={
                        !payment.paymentIntentId ||
                        payment.refundedCents >= payment.amountCents ||
                        refund.isPending
                      }
                      onClick={() => refund.mutate(payment.id)}
                    >
                      Refund remaining
                    </button>
                    <button
                      onClick={() => reconcile.mutate(payment.id)}
                      disabled={reconcile.isPending}
                      style={{ marginLeft: 6 }}
                    >
                      Reconcile
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
