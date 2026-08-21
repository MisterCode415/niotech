import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { money, date } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { Loading, Empty, Alert, Field, Stat } from '../../components/ui';

interface Account {
  accountName: string;
  accountType: string;
  accountReference: string;
  billingEmail: string;
}

interface Charge {
  id: string;
  orderNumber: string;
  amountCents: number;
  status: string;
  batchReference: string | null;
  createdAt: string;
}

export function FulfillmentBilling() {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const slug = me?.memberships.find((m) => m.role === 'fulfillment')?.businessUnitSlug;

  const [form, setForm] = useState<Account>({
    accountName: '',
    accountType: 'invoice',
    accountReference: '',
    billingEmail: '',
  });
  const [message, setMessage] = useState('');

  const account = useQuery({
    queryKey: ['fulfillment', slug, 'account'],
    queryFn: () => api<{ account: Account | null }>(`/api/bu/${slug}/fulfillment/account`),
    enabled: Boolean(slug),
  });

  const charges = useQuery({
    queryKey: ['fulfillment', slug, 'charges'],
    queryFn: () =>
      api<{ charges: Charge[]; pendingCents: number }>(`/api/bu/${slug}/fulfillment/charges`),
    enabled: Boolean(slug),
  });

  useEffect(() => {
    if (account.data?.account) setForm(account.data.account);
  }, [account.data]);

  const save = useMutation({
    mutationFn: () => api(`/api/bu/${slug}/fulfillment/account`, { method: 'PUT', body: form }),
    onSuccess: () => {
      setMessage('Payment account saved.');
      void queryClient.invalidateQueries({ queryKey: ['fulfillment'] });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const batch = useMutation({
    mutationFn: () =>
      api<{ batchReference: string; count: number }>(`/api/bu/${slug}/fulfillment/charges/batch`, {
        method: 'POST',
      }),
    onSuccess: (result) => {
      setMessage(`Batched ${result.count} charge(s) as ${result.batchReference}.`);
      void queryClient.invalidateQueries({ queryKey: ['fulfillment'] });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  if (!slug) return <Empty>You are not assigned to a fulfillment account.</Empty>;
  if (account.isLoading || charges.isLoading) return <Loading what="billing" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Billing</h1>
          <p>Where NIO settles your fulfillment costs, and what is currently outstanding.</p>
        </div>
      </div>

      <Alert tone={save.isError || batch.isError ? 'error' : 'success'}>{message}</Alert>

      <div className="grid cols-3" style={{ marginBottom: 20 }}>
        <Stat label="Outstanding" value={money(charges.data?.pendingCents ?? 0)} />
        <Stat label="Charges recorded" value={charges.data?.charges.length ?? 0} />
        <Stat
          label="Settlement"
          value={<span style={{ fontSize: '1.05rem' }}>{form.accountType}</span>}
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">Payment account</div>
          <Field label="Account name">
            <input
              value={form.accountName}
              onChange={(e) => setForm({ ...form, accountName: e.target.value })}
            />
          </Field>
          <Field label="Settlement method">
            <select
              value={form.accountType}
              onChange={(e) => setForm({ ...form, accountType: e.target.value })}
            >
              <option value="invoice">Invoice</option>
              <option value="ach">ACH</option>
              <option value="wire">Wire</option>
            </select>
          </Field>
          <Field label="Account reference" hint="Bank reference or invoicing identifier.">
            <input
              value={form.accountReference}
              onChange={(e) => setForm({ ...form, accountReference: e.target.value })}
            />
          </Field>
          <Field label="Billing email">
            <input
              type="email"
              value={form.billingEmail}
              onChange={(e) => setForm({ ...form, billingEmail: e.target.value })}
            />
          </Field>
          <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            Save account
          </button>
        </div>

        <div className="card">
          <div className="spread" style={{ marginBottom: 10 }}>
            <div className="card-title" style={{ margin: 0 }}>
              Charges
            </div>
            <button
              onClick={() => batch.mutate()}
              disabled={batch.isPending || (charges.data?.pendingCents ?? 0) === 0}
            >
              Batch outstanding
            </button>
          </div>

          {(charges.data?.charges.length ?? 0) === 0 ? (
            <Empty>No fulfillment charges yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Batch</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {charges.data!.charges.map((charge) => (
                  <tr key={charge.id}>
                    <td className="mono">{charge.orderNumber}</td>
                    <td>{money(charge.amountCents)}</td>
                    <td>
                      <span className={`badge ${charge.status === 'pending' ? 'pending' : 'success'}`}>
                        {charge.status}
                      </span>
                    </td>
                    <td className="mono muted">{charge.batchReference ?? '—'}</td>
                    <td className="muted">{date(charge.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
