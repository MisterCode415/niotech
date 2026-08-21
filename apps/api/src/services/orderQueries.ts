import { and, asc, desc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import {
  clinicianReviews,
  files,
  kits,
  labResults,
  orderEvents,
  orderIssues,
  orders,
  packages,
  shipments,
  testTypes,
  users,
} from '../db/schema.js';
import { notFound } from '../lib/errors.js';

/**
 * One shot of everything a portal needs about an order. Each role's route decides which parts of
 * this to hand back, but they all read from the same shape so the timelines cannot disagree.
 */
export async function getOrderDetail(tx: Tx, businessUnitId: string, orderId: string) {
  const [order] = await tx
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      priceCents: orders.priceCents,
      paymentStatus: orders.paymentStatus,
      shippingAddress: orders.shippingAddress,
      shippingMethod: orders.shippingMethod,
      externalFulfillmentId: orders.externalFulfillmentId,
      requiresClinician: orders.requiresClinician,
      resultsReleasedAt: orders.resultsReleasedAt,
      createdAt: orders.createdAt,
      patientId: users.id,
      patientName: users.name,
      patientEmail: users.email,
      packageId: packages.id,
      packageName: packages.name,
      packageFocusArea: packages.focusArea,
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.patientUserId))
    .innerJoin(packages, eq(packages.id, orders.packageId))
    .where(and(eq(orders.id, orderId), eq(orders.businessUnitId, businessUnitId)))
    .limit(1);

  if (!order) throw notFound('Order not found');

  const kitRows = await tx
    .select({
      id: kits.id,
      kitNumber: kits.kitNumber,
      status: kits.status,
      qrToken: kits.qrToken,
      externalKitId: kits.externalKitId,
      testTypeName: testTypes.name,
      sampleType: testTypes.sampleType,
    })
    .from(kits)
    .innerJoin(testTypes, eq(testTypes.id, kits.testTypeId))
    .where(eq(kits.orderId, orderId))
    .orderBy(asc(kits.kitNumber));

  const shipmentRows = await tx
    .select()
    .from(shipments)
    .where(eq(shipments.orderId, orderId))
    .orderBy(asc(shipments.createdAt));

  const eventRows = await tx
    .select({
      id: orderEvents.id,
      actorRole: orderEvents.actorRole,
      fromStatus: orderEvents.fromStatus,
      toStatus: orderEvents.toStatus,
      message: orderEvents.message,
      metadata: orderEvents.metadata,
      createdAt: orderEvents.createdAt,
      actorName: users.name,
    })
    .from(orderEvents)
    .leftJoin(users, eq(users.id, orderEvents.actorUserId))
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(asc(orderEvents.createdAt));

  const resultRows = await tx
    .select({
      id: labResults.id,
      kitId: labResults.kitId,
      summary: labResults.summary,
      receivedAt: labResults.receivedAt,
      completedAt: labResults.completedAt,
      fileId: files.id,
      filename: files.filename,
      mimeType: files.mimeType,
      sizeBytes: files.sizeBytes,
    })
    .from(labResults)
    .leftJoin(files, eq(files.id, labResults.fileId))
    .where(eq(labResults.orderId, orderId));

  const [review] = await tx
    .select({
      id: clinicianReviews.id,
      decision: clinicianReviews.decision,
      interpretation: clinicianReviews.interpretation,
      recommendations: clinicianReviews.recommendations,
      aiDraft: clinicianReviews.aiDraft,
      aiModel: clinicianReviews.aiModel,
      queuedAt: clinicianReviews.queuedAt,
      decidedAt: clinicianReviews.decidedAt,
      doctorName: users.name,
    })
    .from(clinicianReviews)
    .leftJoin(users, eq(users.id, clinicianReviews.doctorUserId))
    .where(eq(clinicianReviews.orderId, orderId))
    .limit(1);

  const issueRows = await tx
    .select()
    .from(orderIssues)
    .where(eq(orderIssues.orderId, orderId))
    .orderBy(desc(orderIssues.createdAt));

  return {
    order,
    kits: kitRows,
    shipments: shipmentRows,
    events: eventRows,
    results: resultRows,
    review: review ?? null,
    issues: issueRows,
  };
}
