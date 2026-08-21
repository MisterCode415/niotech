import { and, eq } from 'drizzle-orm';
import {
  assertTransition,
  canTransition,
  rollupOrderStatus,
  orderStatusRank,
  ORDER_STATUS_LABELS,
  type ActorRole,
  type OrderStatus,
  type KitStatus,
} from '@nio/shared';
import type { Tx } from '../db/client.js';
import {
  clinicianReviews,
  kits,
  labResults,
  memberships,
  orderEvents,
  orders,
  packages,
  testTypes,
  users,
} from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { draftInterpretation } from './ai.js';
import type { NotificationIntent } from './notifications.js';

export interface WorkflowActor {
  businessUnitId: string;
  actorRole: ActorRole;
  actorUserId: string | null;
}

export async function loadOrder(tx: Tx, businessUnitId: string, orderId: string) {
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.businessUnitId, businessUnitId)))
    .limit(1);
  if (!order) throw notFound('Order not found');
  return order;
}

export async function recordEvent(
  tx: Tx,
  params: {
    businessUnitId: string;
    orderId: string;
    kitId?: string | null;
    actorUserId: string | null;
    actorRole: ActorRole;
    fromStatus?: OrderStatus | null;
    toStatus?: OrderStatus | null;
    message: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(orderEvents).values({
    businessUnitId: params.businessUnitId,
    orderId: params.orderId,
    kitId: params.kitId ?? null,
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    fromStatus: params.fromStatus ?? null,
    toStatus: params.toStatus ?? null,
    message: params.message,
    metadata: params.metadata,
  });
}

/**
 * The only way an order's status ever changes. Illegal or out-of-role transitions throw before
 * anything is written, and every accepted change leaves an audit row behind.
 */
export async function transitionOrder(
  tx: Tx,
  actor: WorkflowActor,
  params: {
    orderId: string;
    to: OrderStatus;
    message: string;
    kitId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<{ from: OrderStatus; to: OrderStatus }> {
  const order = await loadOrder(tx, actor.businessUnitId, params.orderId);
  const from = order.status;

  if (!canTransition(from, params.to, actor.actorRole)) {
    throw badRequest(
      `Cannot move an order from "${ORDER_STATUS_LABELS[from]}" to "${ORDER_STATUS_LABELS[params.to]}" as ${actor.actorRole}`,
      'ILLEGAL_TRANSITION',
    );
  }
  assertTransition(from, params.to, actor.actorRole);

  await tx
    .update(orders)
    .set({ status: params.to, updatedAt: new Date() })
    .where(eq(orders.id, order.id));

  await recordEvent(tx, {
    businessUnitId: actor.businessUnitId,
    orderId: order.id,
    kitId: params.kitId,
    actorUserId: actor.actorUserId,
    actorRole: actor.actorRole,
    fromStatus: from,
    toStatus: params.to,
    message: params.message,
    metadata: params.metadata,
  });

  return { from, to: params.to };
}

export async function setKitStatus(
  tx: Tx,
  actor: WorkflowActor,
  kitId: string,
  status: KitStatus,
): Promise<void> {
  await tx
    .update(kits)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(kits.id, kitId), eq(kits.businessUnitId, actor.businessUnitId)));
}

/**
 * An order follows its slowest kit. Called after any kit-level change; it advances the order only
 * when every kit has reached the next stage and the acting role is allowed to make that move.
 */
export async function syncOrderFromKits(
  tx: Tx,
  actor: WorkflowActor,
  orderId: string,
  message: string,
): Promise<OrderStatus | null> {
  const rows = await tx
    .select({ status: kits.status })
    .from(kits)
    .where(and(eq(kits.orderId, orderId), eq(kits.businessUnitId, actor.businessUnitId)));

  const target = rollupOrderStatus(rows.map((r) => r.status));
  if (!target) return null;

  const order = await loadOrder(tx, actor.businessUnitId, orderId);
  if (target === order.status) return null;
  if (orderStatusRank(target) <= orderStatusRank(order.status)) return null;
  if (!canTransition(order.status, target, actor.actorRole)) return null;

  await transitionOrder(tx, actor, { orderId, to: target, message });
  return target;
}

/**
 * The fork in the diagram: packages that involve a clinic queue the result for a doctor,
 * everything else goes straight back to the patient as raw results.
 */
export async function routeAfterLabCompletion(
  tx: Tx,
  businessUnitId: string,
  orderId: string,
): Promise<{ routedTo: 'doctor' | 'patient'; intents: NotificationIntent[] }> {
  const systemActor: WorkflowActor = { businessUnitId, actorRole: 'system', actorUserId: null };
  const order = await loadOrder(tx, businessUnitId, orderId);

  if (!order.requiresClinician) {
    const intents = await releaseResults(tx, businessUnitId, orderId);
    return { routedTo: 'patient', intents };
  }

  await transitionOrder(tx, systemActor, {
    orderId,
    to: 'awaiting_clinician_review',
    message: 'Results queued for clinician review',
  });

  const [pkg] = await tx
    .select({ name: packages.name, focusArea: packages.focusArea })
    .from(packages)
    .where(eq(packages.id, order.packageId))
    .limit(1);

  const resultRows = await tx
    .select({ summary: labResults.summary, testTypeName: testTypes.name })
    .from(labResults)
    .innerJoin(kits, eq(kits.id, labResults.kitId))
    .innerJoin(testTypes, eq(testTypes.id, kits.testTypeId))
    .where(eq(labResults.orderId, orderId));

  const draft = await draftInterpretation({
    packageName: pkg?.name ?? 'Unknown package',
    focusArea: pkg?.focusArea ?? null,
    testTypeNames: resultRows.map((r) => r.testTypeName),
    labSummary: resultRows.find((r) => r.summary)?.summary ?? null,
  });

  await tx
    .insert(clinicianReviews)
    .values({
      businessUnitId,
      orderId,
      aiDraft: draft.content,
      aiModel: draft.model,
    })
    .onConflictDoNothing();

  // The whole doctor roster is notified; whoever opens it first performs the review.
  const doctors = await tx
    .select({ userId: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.businessUnitId, businessUnitId),
        eq(memberships.role, 'doctor'),
        eq(memberships.status, 'active'),
      ),
    );

  const intents: NotificationIntent[] = doctors.map((doctor) => ({
    businessUnitId,
    userId: doctor.userId,
    email: doctor.email,
    type: 'review_requested',
    title: `New test result to interpret (${order.orderNumber})`,
    body: `Lab analysis is complete for order ${order.orderNumber} and is waiting for your review.`,
    linkPath: `/portal/doctor/reviews/${orderId}`,
    orderId,
  }));

  return { routedTo: 'doctor', intents };
}

/** Final step for both branches: results become visible on the patient dashboard. */
export async function releaseResults(
  tx: Tx,
  businessUnitId: string,
  orderId: string,
): Promise<NotificationIntent[]> {
  const systemActor: WorkflowActor = { businessUnitId, actorRole: 'system', actorUserId: null };

  await transitionOrder(tx, systemActor, {
    orderId,
    to: 'results_released',
    message: 'Results released to patient',
  });

  await tx
    .update(orders)
    .set({ resultsReleasedAt: new Date() })
    .where(eq(orders.id, orderId));

  const [patient] = await tx
    .select({ id: users.id, email: users.email, orderNumber: orders.orderNumber })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.patientUserId))
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!patient) return [];

  return [
    {
      businessUnitId,
      userId: patient.id,
      email: patient.email,
      type: 'results_released',
      title: `Your results for ${patient.orderNumber} are ready`,
      body: 'Your test results are now available in your dashboard.',
      linkPath: `/portal/orders/${orderId}`,
      orderId,
    },
  ];
}
