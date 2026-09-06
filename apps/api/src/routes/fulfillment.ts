import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  correlateOrderSchema,
  flagOrderIssueSchema,
  fulfillmentAccountSchema,
  shipOrderSchema,
  ORDER_ISSUE_REASON_LABELS,
} from '@nio/shared';
import { requireMembership } from '../auth/context.js';
import { env } from '../env.js';
import { withTenant } from '../db/client.js';
import {
  fulfillmentAccounts,
  fulfillmentCharges,
  kits,
  orderIssues,
  orders,
  packages,
  shipments,
  users,
} from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getOrderDetail } from '../services/orderQueries.js';
import { dispatchNotifications, type NotificationIntent } from '../services/notifications.js';
import { recordEvent, setKitStatus, syncOrderFromKits } from '../services/orderWorkflow.js';

const slugParam = z.object({ slug: z.string() });
const orderParam = slugParam.extend({ orderId: z.uuid() });

/** Flat per-order fulfillment cost until a real rate card exists. */
const FULFILLMENT_FEE_CENTS = 795;

export async function fulfillmentRoutes(app: FastifyInstance) {
  app.get('/api/bu/:slug/fulfillment/orders', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['fulfillment']);

    const rows = await withTenant(ctx, (tx) =>
      tx
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          status: orders.status,
          shippingMethod: orders.shippingMethod,
          shippingAddress: orders.shippingAddress,
          externalFulfillmentId: orders.externalFulfillmentId,
          createdAt: orders.createdAt,
          recipientName: users.name,
          packageName: packages.name,
          kitCount: sql<number>`(select count(*)::int from ${kits} k where k.order_id = ${orders.id})`,
          openIssues: sql<number>`(
            select count(*)::int from ${orderIssues} i
            where i.order_id = ${orders.id} and i.status = 'open'
          )`,
        })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.patientUserId))
        .innerJoin(packages, eq(packages.id, orders.packageId))
        .where(
          inArray(orders.status, [
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
          ]),
        )
        .orderBy(desc(orders.createdAt))
        .limit(200),
    );

    return {
      orders: rows,
      queueCount: rows.filter((r) => r.status === 'dispatched_to_fulfillment').length,
    };
  });

  app.get('/api/bu/:slug/fulfillment/orders/:orderId', async (request) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['fulfillment']);

    const detail = await withTenant(ctx, (tx) =>
      getOrderDetail(tx, ctx.businessUnitId, orderId),
    );

    // Fulfillment handles logistics, not clinical data: results and interpretations are withheld.
    return {
      order: detail.order,
      kits: detail.kits.map((kit) => ({
        ...kit,
        // Everything the sticker needs: our id, their id, and the scannable token.
        qrPayload: `${env.WEB_ORIGIN}/scan/${kit.qrToken}`,
      })),
      shipments: detail.shipments,
      events: detail.events,
      issues: detail.issues,
    };
  });

  /** Ties the fulfillment partner's own order id to ours so both ends reconcile. */
  app.post('/api/bu/:slug/fulfillment/orders/:orderId/correlate', async (request) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['fulfillment']);
    const input = correlateOrderSchema.parse(request.body);

    return withTenant(ctx, async (tx) => {
      const [updated] = await tx
        .update(orders)
        .set({ externalFulfillmentId: input.externalOrderId, updatedAt: new Date() })
        .where(eq(orders.id, orderId))
        .returning({ id: orders.id, externalFulfillmentId: orders.externalFulfillmentId });
      if (!updated) throw notFound('Order not found');

      await recordEvent(tx, {
        businessUnitId: ctx.businessUnitId,
        orderId,
        actorUserId: ctx.userId,
        actorRole: 'fulfillment',
        message: `Correlated with fulfillment order ${input.externalOrderId}`,
        metadata: { externalOrderId: input.externalOrderId },
      });

      return { order: updated };
    });
  });

  /** Marks kits as labeled once the QR stickers are printed and applied. */
  app.post('/api/bu/:slug/fulfillment/orders/:orderId/label', async (request) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['fulfillment']);

    return withTenant(ctx, async (tx) => {
      const actor = {
        businessUnitId: ctx.businessUnitId,
        actorRole: 'fulfillment' as const,
        actorUserId: ctx.userId,
      };

      const rows = await tx
        .select({ id: kits.id, status: kits.status })
        .from(kits)
        .where(eq(kits.orderId, orderId));
      if (rows.length === 0) throw notFound('Order has no kits');

      for (const kit of rows.filter((k) => k.status === 'awaiting_fulfillment')) {
        await setKitStatus(tx, actor, kit.id, 'labeled');
      }

      await recordEvent(tx, {
        businessUnitId: ctx.businessUnitId,
        orderId,
        actorUserId: ctx.userId,
        actorRole: 'fulfillment',
        message: `QR labels printed for ${rows.length} kit(s)`,
      });

      return { labeled: rows.length };
    });
  });

  app.post('/api/bu/:slug/fulfillment/orders/:orderId/ship', async (request) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['fulfillment']);
    const input = shipOrderSchema.parse(request.body);

    const intents = await withTenant(ctx, async (tx) => {
      const detail = await getOrderDetail(tx, ctx.businessUnitId, orderId);
      if (detail.order.status !== 'dispatched_to_fulfillment') {
        throw badRequest('This order is not awaiting shipment');
      }

      const actor = {
        businessUnitId: ctx.businessUnitId,
        actorRole: 'fulfillment' as const,
        actorUserId: ctx.userId,
      };

      for (const kit of detail.kits) {
        await setKitStatus(tx, actor, kit.id, 'shipped');
      }

      await tx.insert(shipments).values({
        businessUnitId: ctx.businessUnitId,
        orderId,
        direction: 'outbound_to_patient',
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
        toAddress: detail.order.shippingAddress,
        shippedAt: new Date(),
      });

      await recordEvent(tx, {
        businessUnitId: ctx.businessUnitId,
        orderId,
        actorUserId: ctx.userId,
        actorRole: 'fulfillment',
        message: `Shipped via ${input.carrier} (${input.trackingNumber})`,
        metadata: { carrier: input.carrier, trackingNumber: input.trackingNumber },
      });

      await syncOrderFromKits(tx, actor, orderId, `Kit shipped via ${input.carrier}`);

      // Record the cost so it can be settled in a batch rather than per order.
      const [account] = await tx
        .select({ id: fulfillmentAccounts.id })
        .from(fulfillmentAccounts)
        .where(eq(fulfillmentAccounts.userId, ctx.userId))
        .limit(1);

      await tx
        .insert(fulfillmentCharges)
        .values({
          businessUnitId: ctx.businessUnitId,
          orderId,
          fulfillmentUserId: ctx.userId,
          fulfillmentAccountId: account?.id ?? null,
          amountCents: FULFILLMENT_FEE_CENTS * detail.kits.length,
          status: 'pending',
        })
        .onConflictDoNothing();

      const notificationIntents: NotificationIntent[] = [
        {
          businessUnitId: ctx.businessUnitId,
          userId: detail.order.patientId,
          email: detail.order.patientEmail,
          type: 'kit_shipped',
          title: `Your kit for ${detail.order.orderNumber} has shipped`,
          body: `Tracking ${input.trackingNumber} with ${input.carrier}. Scan the QR code on the kit when it arrives.`,
          linkPath: `/portal/orders/${orderId}`,
          orderId,
        },
      ];

      return notificationIntents;
    });

    await dispatchNotifications(intents);
    return { status: 'kit_shipped' };
  });

  app.post('/api/bu/:slug/fulfillment/orders/:orderId/issues', async (request, reply) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['fulfillment']);
    const input = flagOrderIssueSchema.parse(request.body);

    const issue = await withTenant(ctx, async (tx) => {
      const [row] = await tx
        .insert(orderIssues)
        .values({
          businessUnitId: ctx.businessUnitId,
          orderId,
          reportedByUserId: ctx.userId,
          reason: input.reason,
          detail: input.detail,
        })
        .returning();

      await recordEvent(tx, {
        businessUnitId: ctx.businessUnitId,
        orderId,
        actorUserId: ctx.userId,
        actorRole: 'fulfillment',
        message: `Issue flagged: ${ORDER_ISSUE_REASON_LABELS[input.reason]}`,
        metadata: { reason: input.reason, detail: input.detail },
      });

      return row!;
    });

    return reply.status(201).send({ issue });
  });

  /* ------------------------------- Reconciliation ------------------------------- */

  app.get('/api/bu/:slug/fulfillment/account', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['fulfillment']);

    const [account] = await withTenant(ctx, (tx) =>
      tx
        .select()
        .from(fulfillmentAccounts)
        .where(eq(fulfillmentAccounts.userId, ctx.userId))
        .limit(1),
    );

    return { account: account ?? null };
  });

  app.put('/api/bu/:slug/fulfillment/account', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['fulfillment']);
    const input = fulfillmentAccountSchema.parse(request.body);

    const [account] = await withTenant(ctx, (tx) =>
      tx
        .insert(fulfillmentAccounts)
        .values({ ...input, businessUnitId: ctx.businessUnitId, userId: ctx.userId })
        .onConflictDoUpdate({
          target: [fulfillmentAccounts.businessUnitId, fulfillmentAccounts.userId],
          set: { ...input, updatedAt: new Date() },
        })
        .returning(),
    );

    return { account };
  });

  app.get('/api/bu/:slug/fulfillment/charges', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['fulfillment']);

    return withTenant(ctx, async (tx) => {
      const rows = await tx
        .select({
          id: fulfillmentCharges.id,
          orderNumber: orders.orderNumber,
          amountCents: fulfillmentCharges.amountCents,
          status: fulfillmentCharges.status,
          batchReference: fulfillmentCharges.batchReference,
          createdAt: fulfillmentCharges.createdAt,
        })
        .from(fulfillmentCharges)
        .innerJoin(orders, eq(orders.id, fulfillmentCharges.orderId))
        .where(eq(fulfillmentCharges.fulfillmentUserId, ctx.userId))
        .orderBy(desc(fulfillmentCharges.createdAt))
        .limit(200);

      const pendingCents = rows
        .filter((r) => r.status === 'pending')
        .reduce((sum, r) => sum + r.amountCents, 0);

      return { charges: rows, pendingCents };
    });
  });

  /** Groups everything outstanding into one settlement reference. */
  app.post('/api/bu/:slug/fulfillment/charges/batch', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['fulfillment']);
    const batchReference = `BATCH-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36).toUpperCase()}`;

    const updated = await withTenant(ctx, (tx) =>
      tx
        .update(fulfillmentCharges)
        .set({ status: 'batched', batchReference })
        .where(
          and(
            eq(fulfillmentCharges.status, 'pending'),
            eq(fulfillmentCharges.fulfillmentUserId, ctx.userId),
          ),
        )
        .returning({ id: fulfillmentCharges.id }),
    );

    return { batchReference, count: updated.length };
  });
}
