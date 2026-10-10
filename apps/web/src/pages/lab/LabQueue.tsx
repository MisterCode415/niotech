import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { MockBadge, Loading, Empty, StatusBadge, Stat, Alert } from '../../components/ui';
import { useState } from 'react';
import { KitSerialEntry } from '../../components/KitSerialEntry';

interface QueueRow {
  kitId: string;
  kitNumber: number;
  serial: string;
  kitStatus: string;
  testTypeName: string;
  sampleType: string;
  orderId: string;
  orderNumber: string;
  isMock?: boolean;
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
  const { slug } = useParams();
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
              <td className="mono">
                {row.orderNumber} <MockBadge show={row.isMock} />
              </td>
              <td>
                #{row.kitNumber}
                <div className="small muted mono">{row.serial}</div>
              </td>
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
                  <Link
                    className="btn small"
                    to={`/w/${slug}/lab/orders/${row.orderId}?kit=${row.kitId}`}
                  >
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
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const { slug } = useParams();

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

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-title">Receive a kit by serial</div>
        <p className="small muted" style={{ marginTop: 0 }}>
          For a QR code that will not scan. Entering the serial checks the kit in, exactly as a scan
          would, or opens it for results if it is already here.
        </p>
        <KitSerialEntry buttonLabel="Receive" />
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
        action={{
          label: 'Check in',
          path: (kitId) => `/api/bu/${slug}/lab/kits/${kitId}/check-in`,
        }}
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
