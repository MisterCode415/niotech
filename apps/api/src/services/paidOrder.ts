import { and, eq } from 'drizzle-orm';
import type { ActorRole, OrderPackageSnapshot, ShippingMethod } from '@nio/shared';
import type { Tx } from '../db/client.js';
import { kits, memberships, orders, users } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { generateQrToken } from '../lib/ids.js';
import type { NotificationIntent } from './notifications.js';
import { transitionOrder } from './orderWorkflow.js';

interface PaidOrder {
  id: string;
  orderNumber: string;
  packageSnapshot: OrderPackageSnapshot;
  shippingMethod: ShippingMethod;
}

interface DispatchInput {
  businessUnitId: string;
  order: PaidOrder;
  paymentReference: string;
  actorRole: ActorRole;
  actorUserId: string | null;
}

/**
 * Records an already-authorized payment and creates the immutable package's kits exactly once.
 * The caller owns the transaction and sends returned notifications after commit.
 */
export async function dispatchPaidOrder(
  tx: Tx,
  input: DispatchInput,
): Promise<NotificationIntent[]> {
  const existingKits = await tx
    .select({ id: kits.id })
    .from(kits)
    .where(eq(kits.orderId, input.order.id))
    .limit(1);
  if (existingKits.length > 0) throw badRequest('Order has already been dispatched');

  await tx
    .update(orders)
    .set({ paymentStatus: 'paid', paymentReference: input.paymentReference, updatedAt: new Date() })
    .where(eq(orders.id, input.order.id));

  await transitionOrder(
    tx,
    {
      businessUnitId: input.businessUnitId,
      actorRole: input.actorRole,
      actorUserId: input.actorUserId,
    },
    {
      orderId: input.order.id,
      to: 'paid',
      message: `Payment captured (${input.paymentReference})`,
    },
  );

  let kitNumber = 0;
  const kitValues = input.order.packageSnapshot.tests.flatMap((entry) =>
    Array.from({ length: entry.quantity }, () => {
      kitNumber += 1;
      return {
        businessUnitId: input.businessUnitId,
        orderId: input.order.id,
        testTypeId: entry.testTypeId,
        kitNumber,
        qrToken: generateQrToken(),
        status: 'awaiting_fulfillment' as const,
      };
    }),
  );
  if (kitValues.length === 0) throw badRequest('Package snapshot has no test types');
  await tx.insert(kits).values(kitValues);

  await transitionOrder(
    tx,
    { businessUnitId: input.businessUnitId, actorRole: 'system', actorUserId: null },
    {
      orderId: input.order.id,
      to: 'dispatched_to_fulfillment',
      message: `Dispatched to fulfillment with ${kitValues.length} kit(s)`,
      metadata: { kitCount: kitValues.length },
    },
  );

  const fulfillmentTeam = await tx
    .select({ userId: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.role, 'fulfillment'), eq(memberships.status, 'active')));

  return fulfillmentTeam.map((member) => ({
    businessUnitId: input.businessUnitId,
    userId: member.userId,
    email: member.email,
    type: 'order_dispatched',
    title: `New order to ship: ${input.order.orderNumber}`,
    body: `Order ${input.order.orderNumber} is paid and ready to ship (${kitValues.length} kit(s), ${input.order.shippingMethod}).`,
    linkPath: `/portal/fulfillment/orders/${input.order.id}`,
    orderId: input.order.id,
  }));
}
