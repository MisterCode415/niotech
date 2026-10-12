import { and, eq } from 'drizzle-orm';
import { ORDER_ISSUE_REASON_LABELS, workspacePath, type OrderStatus } from '@nio/shared';
import type { Tx } from '../db/client.js';
import { memberships, users } from '../db/schema.js';
import type { NotificationIntent } from './notifications.js';

export const CORRECTION_FOOTER =
  'This is a correction or update to a previous notice. Please use the latest information.';

export type ReconciliationReason =
  | 'kit_shipped'
  | 'tracking_updated'
  | 'order_cancelled'
  | 'order_corrected'
  | 'shipment_issue'
  | 'results_released'
  | 'review_requested';

interface OrderNotifyContext {
  businessUnitId: string;
  businessUnitSlug: string;
  orderId: string;
  orderNumber: string;
  isMock: boolean;
}

function intent(
  ctx: OrderNotifyContext,
  recipient: { userId: string; email: string },
  type: ReconciliationReason,
  title: string,
  body: string,
  linkPath: string,
): NotificationIntent {
  return {
    businessUnitId: ctx.businessUnitId,
    userId: recipient.userId,
    email: recipient.email,
    type,
    title,
    body,
    linkPath,
    orderId: ctx.orderId,
    skipEmail: ctx.isMock,
  };
}

export function kitShippedIntent(
  ctx: OrderNotifyContext,
  patient: { userId: string; email: string },
  carrier: string,
  trackingNumber: string,
): NotificationIntent {
  return intent(
    ctx,
    patient,
    'kit_shipped',
    `Your kit for ${ctx.orderNumber} has shipped`,
    `Your kit is on the way via ${carrier}. Tracking number: ${trackingNumber}. Scan the QR code on the kit when it arrives.`,
    workspacePath(ctx.businessUnitSlug, 'patient', `/orders/${ctx.orderId}`),
  );
}

export function trackingUpdatedIntent(
  ctx: OrderNotifyContext,
  patient: { userId: string; email: string },
  carrier: string,
  trackingNumber: string,
): NotificationIntent {
  return intent(
    ctx,
    patient,
    'tracking_updated',
    `Updated tracking for ${ctx.orderNumber}`,
    `A correction was posted to your shipment. The current tracking number is ${trackingNumber} with ${carrier}. ${CORRECTION_FOOTER}`,
    workspacePath(ctx.businessUnitSlug, 'patient', `/orders/${ctx.orderId}`),
  );
}

export function orderCancelledIntent(
  ctx: OrderNotifyContext,
  recipient: { userId: string; email: string },
  role: 'patient' | 'fulfillment',
  reason: string,
): NotificationIntent {
  const path =
    role === 'patient'
      ? workspacePath(ctx.businessUnitSlug, 'patient', `/orders/${ctx.orderId}`)
      : workspacePath(ctx.businessUnitSlug, 'fulfillment', `/orders/${ctx.orderId}`);
  return intent(
    ctx,
    recipient,
    'order_cancelled',
    `Order ${ctx.orderNumber} was cancelled`,
    `This order has been cancelled. ${reason} ${CORRECTION_FOOTER}`,
    path,
  );
}

export function orderCorrectedIntent(
  ctx: OrderNotifyContext,
  patient: { userId: string; email: string },
  note: string,
): NotificationIntent {
  return intent(
    ctx,
    patient,
    'order_corrected',
    `An update on order ${ctx.orderNumber}`,
    `${note} ${CORRECTION_FOOTER}`,
    workspacePath(ctx.businessUnitSlug, 'patient', `/orders/${ctx.orderId}`),
  );
}

export function shipmentIssueIntent(
  ctx: OrderNotifyContext,
  recipient: { userId: string; email: string },
  role: 'patient' | 'bu_admin',
  reason: keyof typeof ORDER_ISSUE_REASON_LABELS,
  detail?: string | null,
): NotificationIntent {
  const label = ORDER_ISSUE_REASON_LABELS[reason];
  const extra = detail ? ` ${detail}` : '';
  const path =
    role === 'patient'
      ? workspacePath(ctx.businessUnitSlug, 'patient', `/orders/${ctx.orderId}`)
      : workspacePath(ctx.businessUnitSlug, 'bu_admin', '/orders');
  return intent(
    ctx,
    recipient,
    'shipment_issue',
    `Issue on order ${ctx.orderNumber}: ${label}`,
    `A problem was flagged on this order (${label}).${extra} ${CORRECTION_FOOTER}`,
    path,
  );
}

export function resultsReleasedIntent(
  ctx: OrderNotifyContext,
  patient: { userId: string; email: string },
): NotificationIntent {
  return intent(
    ctx,
    patient,
    'results_released',
    `Your results for ${ctx.orderNumber} are ready`,
    'Your lab report is now available in your dashboard. Sign in to view it.',
    workspacePath(ctx.businessUnitSlug, 'patient', `/orders/${ctx.orderId}`),
  );
}

export function reviewRequestedIntent(
  ctx: OrderNotifyContext,
  doctor: { userId: string; email: string },
): NotificationIntent {
  return intent(
    ctx,
    doctor,
    'review_requested',
    `You have a result to review (${ctx.orderNumber})`,
    `Lab analysis is complete for order ${ctx.orderNumber} and is waiting for your review.`,
    workspacePath(ctx.businessUnitSlug, 'doctor', `/reviews/${ctx.orderId}`),
  );
}

export async function activeMembersByRole(
  tx: Tx,
  businessUnitId: string,
  role: 'fulfillment' | 'bu_admin' | 'doctor',
): Promise<Array<{ userId: string; email: string }>> {
  return tx
    .select({ userId: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.businessUnitId, businessUnitId),
        eq(memberships.role, role),
        eq(memberships.status, 'active'),
      ),
    );
}

const DISPATCHED_OR_LATER: OrderStatus[] = [
  'dispatched_to_fulfillment',
  'kit_shipped',
  'kit_received_by_patient',
  'sample_in_transit',
  'received_by_lab',
  'lab_processing',
  'lab_complete',
  'awaiting_clinician_review',
  'clinician_approved',
  'clinician_rejected',
  'results_released',
];

export function wasDispatchedToFulfillment(status: OrderStatus): boolean {
  return DISPATCHED_OR_LATER.includes(status);
}
