import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { Loading, Empty, StatusBadge } from '../../components/ui';

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  createdAt: string;
  patientName: string;
  packageName: string;
  requiresClinician: boolean;
}

export function AdminOrders() {
  const { slug = '' } = useParams();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', slug, 'orders'],
    queryFn: () => api<{ orders: OrderRow[] }>(`/api/bu/${slug}/orders`),
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

      {(data?.orders.length ?? 0) === 0 ? (
        <Empty>No orders yet.</Empty>
      ) : (
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
                <tr key={order.id}>
                  <td className="mono">{order.orderNumber}</td>
                  <td>{order.patientName}</td>
                  <td>
                    {order.packageName}
                    {order.requiresClinician ? <> <span className="pill">clinician</span></> : null}
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
      )}
    </>
  );
}
