import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { Loading, Empty, Stat } from '../../components/ui';

interface Pending {
  orderId: string;
  orderNumber: string;
  patientName: string;
  packageName: string;
  focusArea: string | null;
  queuedAt: string;
}

interface Decided {
  orderId: string;
  orderNumber: string;
  patientName: string;
  decision: string | null;
  decidedAt: string | null;
}

export function DoctorQueue() {
  const { me } = useAuth();
  const slug = me?.memberships.find((m) => m.role === 'doctor')?.businessUnitSlug;

  const { data, isLoading } = useQuery({
    queryKey: ['doctor', slug, 'queue'],
    queryFn: () => api<{ pending: Pending[]; decided: Decided[] }>(`/api/bu/${slug}/doctor/queue`),
    enabled: Boolean(slug),
    refetchInterval: 30_000,
  });

  if (!slug) return <Empty>You are not on a clinical roster.</Empty>;
  if (isLoading || !data) return <Loading what="review queue" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Review queue</h1>
          <p>Lab results waiting for an interpretation, and the ones you have already signed off.</p>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginBottom: 20 }}>
        <Stat label="Awaiting review" value={data.pending.length} />
        <Stat label="Reviewed by you" value={data.decided.length} />
        <Stat
          label="Approved"
          value={data.decided.filter((d) => d.decision === 'approved').length}
        />
      </div>

      <h2>Awaiting your review</h2>
      {data.pending.length === 0 ? (
        <Empty>The queue is clear.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Patient</th>
                <th>Package</th>
                <th>Focus</th>
                <th>Queued</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.pending.map((row) => (
                <tr key={row.orderId}>
                  <td className="mono">{row.orderNumber}</td>
                  <td>{row.patientName}</td>
                  <td>{row.packageName}</td>
                  <td className="muted">{row.focusArea ?? '—'}</td>
                  <td className="muted">{date(row.queuedAt)}</td>
                  <td>
                    <Link className="btn primary small" to={`/portal/doctor/reviews/${row.orderId}`}>
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 26 }}>Recently decided</h2>
      {data.decided.length === 0 ? (
        <Empty>You have not reviewed anything yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Patient</th>
                <th>Decision</th>
                <th>Decided</th>
              </tr>
            </thead>
            <tbody>
              {data.decided.map((row) => (
                <tr key={row.orderId}>
                  <td className="mono">{row.orderNumber}</td>
                  <td>{row.patientName}</td>
                  <td>
                    <span className={`badge ${row.decision === 'approved' ? 'success' : 'danger'}`}>
                      {row.decision === 'approved' ? 'Approved' : 'Rejected'}
                    </span>
                  </td>
                  <td className="muted">{date(row.decidedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
