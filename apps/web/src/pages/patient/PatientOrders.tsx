import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { money, date } from '../../lib/format';
import { MockBadge, Loading, Empty, StatusBadge } from '../../components/ui';
import { KitSerialEntry } from '../../components/KitSerialEntry';

interface OrderRow {
  id: string;
  orderNumber: string;
  isMock?: boolean;
  status: string;
  priceCents: number;
  createdAt: string;
  packageName: string;
  requiresClinician: boolean;
}

export function PatientOrders() {
  const { slug } = useParams();

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

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-title">Kit arrived? Scan the QR code on the box</div>
        <p className="small muted" style={{ marginTop: 0 }}>
          If the code will not scan, enter the serial printed under it instead.
        </p>
        <KitSerialEntry buttonLabel="Register kit" />
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
                  <td className="mono">
                    {order.orderNumber} <MockBadge show={order.isMock} />
                  </td>
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
                    <Link className="btn small" to={`/w/${slug}/patient/orders/${order.id}`}>
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
