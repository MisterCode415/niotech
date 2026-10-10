import { Link, useSearchParams } from 'react-router-dom';
import { workspacePath } from '@nio/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Alert, Loading } from '../components/ui';

export function CheckoutReturn() {
  const [params] = useSearchParams();
  const orderId = params.get('order') ?? '';
  const slug = params.get('slug') ?? '';
  const cancelled = params.get('cancelled') === '1';

  const order = useQuery({
    queryKey: ['checkout-return', slug, orderId],
    queryFn: () =>
      api<{ order: { id: string; paymentStatus: string; status: string } }>(
        `/api/bu/${slug}/patient/orders/${orderId}`,
      ),
    enabled: Boolean(slug && orderId),
    refetchInterval: (query) => {
      const paymentStatus = query.state.data?.order.paymentStatus;
      return paymentStatus === 'pending' || paymentStatus === 'processing' ? 1500 : false;
    },
  });
  const retry = useMutation({
    mutationFn: () =>
      api<{ checkoutUrl?: string }>(`/api/bu/${slug}/patient/orders/${orderId}/pay`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: ({ checkoutUrl }) => {
      if (checkoutUrl) window.location.assign(checkoutUrl);
    },
  });

  if (!slug || !orderId) return <Alert tone="error">The checkout return link is incomplete.</Alert>;
  if (order.isLoading) return <Loading what="payment confirmation" />;
  if (order.isError) return <Alert tone="error">Could not load this order.</Alert>;

  const paymentStatus = order.data!.order.paymentStatus;
  const paid = ['paid', 'partially_refunded', 'refunded', 'disputed'].includes(paymentStatus);

  return (
    <div className="auth-card" style={{ margin: '40px auto' }}>
      <h1>{paid ? 'Payment received' : cancelled ? 'Checkout cancelled' : 'Confirming payment'}</h1>
      {paid ? (
        <p>Your order is now in the fulfillment workflow.</p>
      ) : cancelled ? (
        <p>No completed payment was recorded. You can return to the storefront and try again.</p>
      ) : paymentStatus === 'failed' || paymentStatus === 'expired' ? (
        <Alert tone="error">Payment was not completed. Please return to the storefront.</Alert>
      ) : (
        <p className="muted">
          Stripe is still confirming the payment. This page updates automatically.
        </p>
      )}
      <Link className="btn primary" to={workspacePath(slug, 'patient', `/orders/${orderId}`)}>
        View order
      </Link>
      {!paid && (
        <>
          <button
            className="primary"
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
            style={{ marginLeft: 8 }}
          >
            Try payment again
          </button>
          <Link className="btn" to={`/${slug}`} style={{ marginLeft: 8 }}>
            Return to storefront
          </Link>
        </>
      )}
    </div>
  );
}
