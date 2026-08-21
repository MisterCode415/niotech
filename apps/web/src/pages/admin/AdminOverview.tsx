import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ROLE_LABELS, type MembershipRole } from '@nio/shared';
import { api } from '../../lib/api';
import { Loading, Stat } from '../../components/ui';

interface Summary {
  orders: { totalOrders: number; awaitingReview: number; released: number };
  roster: Array<{ role: MembershipRole; count: number }>;
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
          <Link className="btn small" to={`/portal/admin/${slug}/team`} style={{ marginTop: 10 }}>
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
    </>
  );
}
