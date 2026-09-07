import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { Loading, Empty, StatusBadge, Stat } from '../../components/ui';

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  shippingMethod: string;
  externalFulfillmentId: string | null;
  createdAt: string;
  recipientName: string;
  packageName: string;
  kitCount: number;
  openIssues: number;
}

export function FulfillmentQueue() {
  const { me } = useAuth();
  const slug = me?.memberships.find((m) => m.role === 'fulfillment')?.businessUnitSlug;

  const { data, isLoading } = useQuery({
    queryKey: ['fulfillment', slug, 'orders'],
    queryFn: () =>
      api<{ orders: OrderRow[]; queueCount: number }>(`/api/bu/${slug}/fulfillment/orders`),
    enabled: Boolean(slug),
  });

  if (!slug) return <Empty>You are not assigned to a fulfillment account.</Empty>;
  if (isLoading) return <Loading what="orders" />;

  const orders = data?.orders ?? [];
  const shipped = orders.filter((o) => o.status !== 'dispatched_to_fulfillment').length;
  const issues = orders.reduce((sum, o) => sum + o.openIssues, 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Fulfillment queue</h1>
          <p>Orders that are paid and waiting to ship, plus everything already on its way.</p>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginBottom: 20 }}>
        <Stat label="Awaiting shipment" value={data?.queueCount ?? 0} />
        <Stat label="Shipped" value={shipped} />
        <Stat label="Open issues" value={issues} />
      </div>

      {orders.length === 0 ? (
        <Empty>No orders have reached fulfillment yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Qinio order</th>
                <th>Your reference</th>
                <th>Recipient</th>
                <th>Kits</th>
                <th>Ship</th>
                <th>Received</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td className="mono">{order.orderNumber}</td>
                  <td className="mono muted">{order.externalFulfillmentId ?? '—'}</td>
                  <td>{order.recipientName}</td>
                  <td>{order.kitCount}</td>
                  <td className="muted">{order.shippingMethod}</td>
                  <td className="muted">{date(order.createdAt)}</td>
                  <td>
                    <StatusBadge status={order.status} />
                    {order.openIssues > 0 ? (
                      <>
                        {' '}
                        <span className="badge danger">{order.openIssues} issue</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <Link className="btn small" to={`/portal/fulfillment/orders/${order.id}`}>
                      Open
                    </Link>
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
