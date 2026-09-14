import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { createOrderSchema, payOrderSchema } from '@nio/shared';
import { requireMembership } from '../auth/context.js';
import { withTenant } from '../db/client.js';
import {
  files,
  kits,
  labResults,
  orders,
  packageTestTypes,
  packages,
  shipments,
  testTypes,
} from '../db/schema.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { generateOrderNumber } from '../lib/ids.js';
import { getOrderDetail } from '../services/orderQueries.js';
import { paymentProvider } from '../services/payments.js';
import { dispatchNotifications } from '../services/notifications.js';
import { dispatchPaidOrder } from '../services/paidOrder.js';
import {
  recordEvent,
  setKitStatus,
  syncOrderFromKits,
} from '../services/orderWorkflow.js';
import { storage } from '../services/storage.js';

const slugParam = z.object({ slug: z.string() });
const orderParam = slugParam.extend({ orderId: z.uuid() });
const kitParam = orderParam.extend({ kitId: z.uuid() });

export async function patientRoutes(app: FastifyInstance) {
  app.get('/api/bu/:slug/patient/orders', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['patient']);

    const rows = await withTenant(ctx, (tx) =>
      tx
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          status: orders.status,
          priceCents: orders.priceCents,
          createdAt: orders.createdAt,
          packageName: packages.name,
          requiresClinician: orders.requiresClinician,
          resultsReleasedAt: orders.resultsReleasedAt,
        })
        .from(orders)
        .innerJoin(packages, eq(packages.id, orders.packageId))
        .where(eq(orders.patientUserId, ctx.userId))
        .orderBy(desc(orders.createdAt)),
    );

    return { orders: rows };
  });

  app.post('/api/bu/:slug/patient/orders', async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['patient']);
    const input = createOrderSchema.parse(request.body);

    const order = await withTenant(ctx, async (tx) => {
      const [pkg] = await tx
        .select()
        .from(packages)
        .where(and(eq(packages.id, input.packageId), eq(packages.status, 'active')))
        .limit(1);
      if (!pkg) throw notFound('Package not available');

      const composition = await tx
        .select({
          testTypeId: testTypes.id,
          name: testTypes.name,
          sampleType: testTypes.sampleType,
          turnaroundDays: testTypes.turnaroundDays,
          quantity: packageTestTypes.quantity,
        })
        .from(packageTestTypes)
        .innerJoin(testTypes, eq(testTypes.id, packageTestTypes.testTypeId))
        .where(eq(packageTestTypes.packageId, pkg.id));
      if (composition.length === 0) throw badRequest('Package has no test types configured');

      const [created] = await tx
        .insert(orders)
        .values({
          businessUnitId: ctx.businessUnitId,
          orderNumber: generateOrderNumber(),
          patientUserId: ctx.userId,
          packageId: pkg.id,
          status: 'pending_payment',
          priceCents: pkg.priceCents,
          paymentStatus: 'unpaid',
          packageSnapshot: {
            packageName: pkg.name,
            packageVersion: pkg.version,
            priceCents: pkg.priceCents,
            requiresClinician: pkg.requiresClinician,
            internalReference: pkg.internalReference,
            externalProductId: pkg.externalProductId,
            tests: composition,
          },
          shippingAddress: input.shippingAddress,
          shippingMethod: input.shippingMethod,
          requiresClinician: pkg.requiresClinician,
        })
        .returning();

      await recordEvent(tx, {
        businessUnitId: ctx.businessUnitId,
        orderId: created!.id,
        actorUserId: ctx.userId,
        actorRole: 'patient',
        toStatus: 'pending_payment',
        message: `Order placed for ${pkg.name}`,
        metadata: { packageId: pkg.id },
      });

      return created!;
    });

    return reply.status(201).send({ order });
  });

  /**
   * Payment, kit creation and hand-off to fulfillment happen in one transaction: a paid order
   * with no kits, or kits with no dispatch, would both leave the workflow stuck.
   */
  app.post('/api/bu/:slug/patient/orders/:orderId/pay', async (request) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['patient']);
    const input = payOrderSchema.parse(request.body ?? {});

    const { status, intents } = await withTenant(ctx, async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.patientUserId, ctx.userId)))
        .limit(1);
      if (!order) throw notFound('Order not found');
      if (order.status !== 'pending_payment') throw badRequest('Order is not awaiting payment');

      const charge = await paymentProvider.charge({
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountCents: order.priceCents,
        paymentToken: input.paymentToken,
      });

      if (charge.status !== 'paid') {
        await tx.update(orders).set({ paymentStatus: 'failed' }).where(eq(orders.id, order.id));
        throw badRequest('Payment was declined');
      }

      const notificationIntents = await dispatchPaidOrder(tx, {
        businessUnitId: ctx.businessUnitId,
        order,
        paymentReference: charge.reference,
        actorRole: 'patient',
        actorUserId: ctx.userId,
      });

      return { status: 'dispatched_to_fulfillment' as const, intents: notificationIntents };
    });

    await dispatchNotifications(intents);
    return { status };
  });

  app.get('/api/bu/:slug/patient/orders/:orderId', async (request) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['patient']);

    const detail = await withTenant(ctx, (tx) =>
      getOrderDetail(tx, ctx.businessUnitId, orderId),
    );
    if (detail.order.patientId !== ctx.userId) throw forbidden('This order belongs to another patient');

    // Results are only visible once released; before that the doctor's queue owns them.
    const released = detail.order.status === 'results_released';
    return {
      ...detail,
      results: released ? detail.results : [],
      review: released ? detail.review : null,
      // The QR token is the kit's credential; the patient sees their own, nobody else's.
      kits: detail.kits,
    };
  });

  /** Step 8 in the flow: the kit arrived and the patient confirms it, usually by scanning. */
  app.post('/api/bu/:slug/patient/orders/:orderId/kits/:kitId/received', async (request) => {
    const { slug, orderId, kitId } = kitParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['patient']);

    return withTenant(ctx, async (tx) => {
      const [ownedOrder] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.patientUserId, ctx.userId)))
        .limit(1);
      if (!ownedOrder) throw notFound('Kit not found');

      const [kit] = await tx
        .select()
        .from(kits)
        .where(and(eq(kits.id, kitId), eq(kits.orderId, orderId)))
        .limit(1);
      if (!kit) throw notFound('Kit not found');
      if (kit.status !== 'shipped') throw badRequest('This kit has not shipped yet');

      const actor = {
        businessUnitId: ctx.businessUnitId,
        actorRole: 'patient' as const,
        actorUserId: ctx.userId,
      };

      await setKitStatus(tx, actor, kitId, 'received_by_patient');
      await recordEvent(tx, {
        businessUnitId: ctx.businessUnitId,
        orderId,
        kitId,
        actorUserId: ctx.userId,
        actorRole: 'patient',
        message: `Kit #${kit.kitNumber} confirmed received by patient`,
      });
      await syncOrderFromKits(tx, actor, orderId, 'All kits received by patient');

      return { kitStatus: 'received_by_patient' };
    });
  });

  /** The sample is boxed with the prepaid lab label and dropped in the mail. */
  app.post('/api/bu/:slug/patient/orders/:orderId/kits/:kitId/sent-to-lab', async (request) => {
    const { slug, orderId, kitId } = kitParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['patient']);

    return withTenant(ctx, async (tx) => {
      const [ownedOrder] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.patientUserId, ctx.userId)))
        .limit(1);
      if (!ownedOrder) throw notFound('Kit not found');

      const [kit] = await tx
        .select()
        .from(kits)
        .where(and(eq(kits.id, kitId), eq(kits.orderId, orderId)))
        .limit(1);
      if (!kit) throw notFound('Kit not found');
      if (kit.status !== 'received_by_patient') {
        throw badRequest('Confirm you received this kit before sending the sample');
      }

      const actor = {
        businessUnitId: ctx.businessUnitId,
        actorRole: 'patient' as const,
        actorUserId: ctx.userId,
      };

      await setKitStatus(tx, actor, kitId, 'sample_in_transit');
      await recordEvent(tx, {
        businessUnitId: ctx.businessUnitId,
        orderId,
        kitId,
        actorUserId: ctx.userId,
        actorRole: 'patient',
        message: `Sample for kit #${kit.kitNumber} sent to the lab`,
      });

      await tx
        .insert(shipments)
        .values({
          businessUnitId: ctx.businessUnitId,
          orderId,
          direction: 'inbound_to_lab',
          shippedAt: new Date(),
        })
        .onConflictDoNothing();

      await syncOrderFromKits(tx, actor, orderId, 'All samples are in transit to the lab');

      return { kitStatus: 'sample_in_transit' };
    });
  });

  /** PHI download. Never served from static storage: tenant, ownership and release are all checked. */
  app.get('/api/bu/:slug/patient/orders/:orderId/results/:fileId', async (request, reply) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const { fileId } = z.object({ fileId: z.uuid() }).parse(request.params);
    const ctx = requireMembership(request, slug, ['patient']);

    const file = await withTenant(ctx, async (tx) => {
      const [order] = await tx
        .select({ id: orders.id, status: orders.status, patientUserId: orders.patientUserId })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (!order) throw notFound('Order not found');
      if (order.patientUserId !== ctx.userId) throw forbidden();
      if (order.status !== 'results_released') throw forbidden('Results have not been released yet');

      const [row] = await tx
        .select({
          storageKey: files.storageKey,
          filename: files.filename,
          mimeType: files.mimeType,
        })
        .from(labResults)
        .innerJoin(files, eq(files.id, labResults.fileId))
        .where(and(eq(labResults.orderId, orderId), eq(files.id, fileId)))
        .limit(1);
      if (!row) throw notFound('Result file not found');
      return row;
    });

    const bytes = await storage.get(file.storageKey);
    return reply
      .header('content-type', file.mimeType)
      .header('content-disposition', `inline; filename="${file.filename}"`)
      .send(bytes);
  });
}
