import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { submitReviewSchema } from '@nio/shared';
import { requireMembership } from '../auth/context.js';
import { withTenant } from '../db/client.js';
import { clinicianReviews, files, labResults, orders, packages, users } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getOrderDetail } from '../services/orderQueries.js';
import { dispatchNotifications } from '../services/notifications.js';
import { releaseResults, transitionOrder } from '../services/orderWorkflow.js';
import { storage } from '../services/storage.js';

const slugParam = z.object({ slug: z.string() });
const orderParam = slugParam.extend({ orderId: z.uuid() });

export async function doctorRoutes(app: FastifyInstance) {
  app.get('/api/bu/:slug/doctor/queue', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['doctor']);

    return withTenant(ctx, async (tx) => {
      const pending = await tx
        .select({
          orderId: orders.id,
          orderNumber: orders.orderNumber,
          patientName: users.name,
          packageName: packages.name,
          focusArea: packages.focusArea,
          queuedAt: clinicianReviews.queuedAt,
        })
        .from(clinicianReviews)
        .innerJoin(orders, eq(orders.id, clinicianReviews.orderId))
        .innerJoin(users, eq(users.id, orders.patientUserId))
        .innerJoin(packages, eq(packages.id, orders.packageId))
        .where(isNull(clinicianReviews.decidedAt))
        .orderBy(asc(clinicianReviews.queuedAt));

      const decided = await tx
        .select({
          orderId: orders.id,
          orderNumber: orders.orderNumber,
          patientName: users.name,
          decision: clinicianReviews.decision,
          decidedAt: clinicianReviews.decidedAt,
        })
        .from(clinicianReviews)
        .innerJoin(orders, eq(orders.id, clinicianReviews.orderId))
        .innerJoin(users, eq(users.id, orders.patientUserId))
        .where(eq(clinicianReviews.doctorUserId, ctx.userId))
        .orderBy(asc(clinicianReviews.decidedAt))
        .limit(50);

      return { pending, decided };
    });
  });

  app.get('/api/bu/:slug/doctor/reviews/:orderId', async (request) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['doctor']);

    const detail = await withTenant(ctx, (tx) =>
      getOrderDetail(tx, ctx.businessUnitId, orderId),
    );

    if (!detail.order.requiresClinician) {
      throw badRequest('This package does not involve a clinician');
    }

    return detail;
  });

  /** Reads the results PDF for review. Available to the doctor before release, unlike the patient. */
  app.get('/api/bu/:slug/doctor/reviews/:orderId/results/:fileId', async (request, reply) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const { fileId } = z.object({ fileId: z.uuid() }).parse(request.params);
    const ctx = requireMembership(request, slug, ['doctor']);

    const file = await withTenant(ctx, async (tx) => {
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

  /**
   * The doctor's yes/no plus their explanation. Either decision releases the results to the
   * patient: a rejection still has to reach them, together with what would change the answer.
   */
  app.post('/api/bu/:slug/doctor/reviews/:orderId', async (request) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['doctor']);
    const input = submitReviewSchema.parse(request.body);

    const intents = await withTenant(ctx, async (tx) => {
      const [review] = await tx
        .select()
        .from(clinicianReviews)
        .where(eq(clinicianReviews.orderId, orderId))
        .limit(1);
      if (!review) throw notFound('This order is not queued for review');
      if (review.decidedAt) throw badRequest('This order has already been reviewed');

      await tx
        .update(clinicianReviews)
        .set({
          doctorUserId: ctx.userId,
          decision: input.decision,
          interpretation: input.interpretation,
          recommendations: input.recommendations,
          decidedAt: new Date(),
        })
        .where(eq(clinicianReviews.id, review.id));

      await transitionOrder(
        tx,
        { businessUnitId: ctx.businessUnitId, actorRole: 'doctor', actorUserId: ctx.userId },
        {
          orderId,
          to: input.decision === 'approved' ? 'clinician_approved' : 'clinician_rejected',
          message:
            input.decision === 'approved'
              ? 'Doctor approved the plan'
              : 'Doctor rejected the plan with recommendations',
          metadata: { decision: input.decision },
        },
      );

      return releaseResults(tx, ctx.businessUnitId, orderId);
    });

    await dispatchNotifications(intents);
    return { decision: input.decision, status: 'results_released' };
  });
}
