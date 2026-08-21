import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Loading, Empty, StatusBadge, Stat, Alert } from '../../components/ui';
import { useState } from 'react';

interface QueueRow {
  kitId: string;
  kitNumber: number;
  kitStatus: string;
  testTypeName: string;
  sampleType: string;
  orderId: string;
  orderNumber: string;
  packageName: string;
  patientName: string;
  requiresClinician: boolean;
}

interface Queue {
  incoming: QueueRow[];
  inLab: QueueRow[];
  completed: QueueRow[];
}

function KitTable({
  rows,
  action,
  onAction,
  busy,
}: {
  rows: QueueRow[];
  action?: { label: string; path: (kitId: string) => string };
  onAction?: (path: string) => void;
  busy?: boolean;
}) {
  if (rows.length === 0) return <Empty>Nothing here.</Empty>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Kit</th>
            <th>Panel</th>
            <th>Patient</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.kitId}>
              <td className="mono">{row.orderNumber}</td>
              <td>#{row.kitNumber}</td>
              <td>
                {row.testTypeName}
                <div className="small muted">{row.sampleType}</div>
              </td>
              <td>{row.patientName}</td>
              <td>
                <StatusBadge status={row.kitStatus} kind="kit" />
              </td>
              <td>
                <div className="row">
                  {action && onAction ? (
                    <button
                      className="primary small"
                      disabled={busy}
                      onClick={() => onAction(action.path(row.kitId))}
                    >
                      {action.label}
                    </button>
                  ) : null}
                  <Link className="btn small" to={`/portal/lab/orders/${row.orderId}`}>
                    Open
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LabQueue() {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const slug = me?.memberships.find((m) => m.role === 'lab')?.businessUnitSlug;

  const { data, isLoading } = useQuery({
    queryKey: ['lab', slug, 'queue'],
    queryFn: () => api<Queue>(`/api/bu/${slug}/lab/queue`),
    enabled: Boolean(slug),
  });

  const act = useMutation({
    mutationFn: (path: string) => api(path, { method: 'POST' }),
    onSuccess: () => {
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['lab'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!slug) return <Empty>You are not assigned to a lab.</Empty>;
  if (isLoading || !data) return <Loading what="lab queue" />;

  const awaitingCheckIn = data.incoming.filter((r) => r.kitStatus === 'sample_in_transit');

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Lab queue</h1>
          <p>
            Samples on their way, samples on the bench, and analyses that are already finished.
            Check-in normally happens by scanning the kit at goods-in.
          </p>
        </div>
      </div>

      <Alert tone="error">{error}</Alert>

      <div className="grid cols-3" style={{ marginBottom: 20 }}>
        <Stat label="In transit" value={data.incoming.length} />
        <Stat label="On the bench" value={data.inLab.length} />
        <Stat label="Completed" value={data.completed.length} />
      </div>

      <h2>Ready to check in</h2>
      <KitTable
        rows={awaitingCheckIn}
        action={{ label: 'Check in', path: (kitId) => `/api/bu/${slug}/lab/kits/${kitId}/check-in` }}
        onAction={(path) => act.mutate(path)}
        busy={act.isPending}
      />

      <h2 style={{ marginTop: 26 }}>On the bench</h2>
      <KitTable
        rows={data.inLab}
        action={{ label: 'Start', path: (kitId) => `/api/bu/${slug}/lab/kits/${kitId}/start` }}
        onAction={(path) => act.mutate(path)}
        busy={act.isPending}
      />

      <h2 style={{ marginTop: 26 }}>Incoming (read only)</h2>
      <KitTable rows={data.incoming.filter((r) => r.kitStatus !== 'sample_in_transit')} />

      <h2 style={{ marginTop: 26 }}>Completed</h2>
      <KitTable rows={data.completed} />
    </>
  );
}
