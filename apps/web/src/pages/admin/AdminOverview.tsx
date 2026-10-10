import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ROLE_LABELS,
  ORDER_STATUS_LABELS,
  workspacePath,
  type MembershipRole,
  type OrderStatus,
} from '@nio/shared';
import { api } from '../../lib/api';
import { useAuthConfig } from '../../lib/authConfig';
import { Alert, Loading, Stat } from '../../components/ui';

interface Summary {
  orders: { totalOrders: number; awaitingReview: number; released: number };
  roster: Array<{ role: MembershipRole; count: number }>;
}

interface SeedResult {
  orders: Array<{ orderNumber: string; status: OrderStatus; queue: string; patient: string }>;
}

export function AdminOverview() {
  const { slug = '' } = useParams();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', slug, 'summary'],
    queryFn: () => api<Summary>(`/api/bu/${slug}/summary`),
  });

  if (isLoading || !data) return <Loading what="overview" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Overview</h1>
          <p>
            Your storefront lives at <Link to={`/${slug}`}>/{slug}</Link>.
          </p>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginBottom: 22 }}>
        <Stat label="Orders" value={data.orders.totalOrders} />
        <Stat label="Awaiting doctor" value={data.orders.awaitingReview} />
        <Stat label="Results released" value={data.orders.released} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">Your team</div>
          {data.roster.length === 0 ? (
            <p className="small muted">No members yet.</p>
          ) : (
            data.roster.map((entry) => (
              <div key={entry.role} className="spread" style={{ marginBottom: 8 }}>
                <span>{ROLE_LABELS[entry.role]}</span>
                <strong>{entry.count}</strong>
              </div>
            ))
          )}
          <Link
            className="btn small"
            to={workspacePath(slug, 'bu_admin', '/team')}
            style={{ marginTop: 10 }}
          >
            Manage team
          </Link>
        </div>

        <div className="card">
          <div className="card-title">Setup checklist</div>
          <ol className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
            <li>Publish your marketing page.</li>
            <li>Add the test types your lab runs.</li>
            <li>Build packages, and decide which need a doctor.</li>
            <li>Invite your fulfillment, lab and clinical users.</li>
          </ol>
        </div>
      </div>

      <MockFlowCard slug={slug} />
    </>
  );
}

function MockFlowCard({ slug }: { slug: string }) {
  const { simulationEnabled } = useAuthConfig();
  const queryClient = useQueryClient();
  const [seeded, setSeeded] = useState<SeedResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seed = useMutation({
    mutationFn: () => api<SeedResult>(`/api/bu/${slug}/simulation/seed`, { method: 'POST' }),
    onSuccess: (result) => {
      setSeeded(result);
      setMessage(null);
      setError(null);
      void queryClient.invalidateQueries();
    },
    onError: (err: Error) => setError(err.message),
  });

  const clear = useMutation({
    mutationFn: () =>
      api<{ removedOrders: number }>(`/api/bu/${slug}/simulation`, { method: 'DELETE' }),
    onSuccess: (result) => {
      setSeeded(null);
      setMessage(
        `Removed ${result.removedOrders} mock order${result.removedOrders === 1 ? '' : 's'}.`,
      );
      setError(null);
      void queryClient.invalidateQueries();
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!simulationEnabled) return null;

  const busy = seed.isPending || clear.isPending;

  return (
    <div className="card" style={{ marginTop: 22 }}>
      <div className="spread">
        <div className="card-title" style={{ margin: 0 }}>
          Mock flow <span className="badge mock">Test only</span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn small primary"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Seed one mock order into every queue of this business unit?'))
                seed.mutate();
            }}
          >
            {seed.isPending ? 'Seeding…' : 'Mock flow'}
          </button>
          <button
            className="btn small"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  'Delete every mock order, mock patient and mock package in this business unit?',
                )
              )
                clear.mutate();
            }}
          >
            {clear.isPending ? 'Clearing…' : 'Clear mock data'}
          </button>
        </div>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>
        Seeds one order at each stage, from fulfillment through lab and doctor review to released
        results, using draft mock packages and mock patients. Nothing is charged or emailed. Use the
        workspace switcher to work each queue as its role; mock orders carry a{' '}
        <span className="badge mock">Mock</span> badge.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {message && <Alert tone="success">{message}</Alert>}
      {seeded && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Queue</th>
                <th>Status</th>
                <th>Patient</th>
              </tr>
            </thead>
            <tbody>
              {seeded.orders.map((order) => (
                <tr key={order.orderNumber}>
                  <td className="mono">{order.orderNumber}</td>
                  <td>{order.queue}</td>
                  <td>{ORDER_STATUS_LABELS[order.status]}</td>
                  <td>{order.patient}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
