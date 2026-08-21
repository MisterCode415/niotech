import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { money, date } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { Loading, Empty, StatusBadge } from '../../components/ui';

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  priceCents: number;
  createdAt: string;
  packageName: string;
  requiresClinician: boolean;
}

export function PatientOrders() {
  const { me } = useAuth();
  const membership = me?.memberships.find((m) => m.role === 'patient');
  const slug = membership?.businessUnitSlug;

  const { data, isLoading } = useQuery({
    queryKey: ['patient', slug, 'orders'],
    queryFn: () => api<{ orders: OrderRow[] }>(`/api/bu/${slug}/patient/orders`),
    enabled: Boolean(slug),
  });

  if (!slug) return <Empty>You are not registered as a patient with any business unit.</Empty>;
  if (isLoading) return <Loading what="orders" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>My orders</h1>
          <p>Track your kit from dispatch through to your results.</p>
        </div>
        <Link className="btn" to={`/${slug}`}>
          Browse packages
        </Link>
      </div>

      {(data?.orders.length ?? 0) === 0 ? (
        <Empty>
          You have not ordered a kit yet. <Link to={`/${slug}`}>Browse packages</Link>.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Package</th>
                <th>Placed</th>
                <th>Total</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data!.orders.map((order) => (
                <tr key={order.id}>
                  <td className="mono">{order.orderNumber}</td>
                  <td>
                    {order.packageName}
                    {order.requiresClinician ? (
                      <>
                        {' '}
                        <span className="pill">doctor reviewed</span>
                      </>
                    ) : null}
                  </td>
                  <td className="muted">{date(order.createdAt)}</td>
                  <td>{money(order.priceCents)}</td>
                  <td>
                    <StatusBadge status={order.status} />
                  </td>
                  <td>
                    <Link className="btn small" to={`/portal/orders/${order.id}`}>
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
