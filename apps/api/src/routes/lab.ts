import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { completeAnalysisSchema } from '@nio/shared';
import { requireMembership } from '../auth/context.js';
import { withTenant } from '../db/client.js';
import { files, kits, labResults, orders, packages, testTypes, users } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { generateStorageKey } from '../lib/ids.js';
import { getOrderDetail } from '../services/orderQueries.js';
import { dispatchNotifications } from '../services/notifications.js';
import {
  recordEvent,
  routeAfterLabCompletion,
  setKitStatus,
  syncOrderFromKits,
} from '../services/orderWorkflow.js';
import { storage } from '../services/storage.js';

const slugParam = z.object({ slug: z.string() });
const kitParam = slugParam.extend({ kitId: z.uuid() });
const orderParam = slugParam.extend({ orderId: z.uuid() });

const ACCEPTED_RESULT_TYPES = new Set(['application/pdf']);

export async function labRoutes(app: FastifyInstance) {
  /** Everything heading to, sitting in, or finished at the lab. Incoming rows are read-only. */
  app.get('/api/bu/:slug/lab/queue', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['lab']);

    const rows = await withTenant(ctx.businessUnitId, (tx) =>
      tx
        .select({
          kitId: kits.id,
          kitNumber: kits.kitNumber,
          kitStatus: kits.status,
          externalKitId: kits.externalKitId,
          testTypeName: testTypes.name,
          sampleType: testTypes.sampleType,
          orderId: orders.id,
          orderNumber: orders.orderNumber,
          orderStatus: orders.status,
          packageName: packages.name,
          patientName: users.name,
          requiresClinician: orders.requiresClinician,
        })
        .from(kits)
        .innerJoin(orders, eq(orders.id, kits.orderId))
        .innerJoin(packages, eq(packages.id, orders.packageId))
        .innerJoin(testTypes, eq(testTypes.id, kits.testTypeId))
        .innerJoin(users, eq(users.id, orders.patientUserId))
        .where(
          inArray(kits.status, [
            'shipped',
            'received_by_patient',
            'sample_in_transit',
            'received_by_lab',
            'processing',
            'lab_complete',
          ]),
        )
        .orderBy(asc(orders.createdAt), asc(kits.kitNumber)),
    );

    return {
      incoming: rows.filter((r) =>
        ['shipped', 'received_by_patient', 'sample_in_transit'].includes(r.kitStatus),
      ),
      inLab: rows.filter((r) => ['received_by_lab', 'processing'].includes(r.kitStatus)),
      completed: rows.filter((r) => r.kitStatus === 'lab_complete'),
    };
  });

  app.get('/api/bu/:slug/lab/orders/:orderId', async (request) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['lab']);

    const detail = await withTenant(ctx.businessUnitId, (tx) =>
      getOrderDetail(tx, ctx.businessUnitId, orderId),
    );
    return { ...detail, review: null };
  });

  /** Physical arrival, normally triggered by scanning the kit's QR code at goods-in. */
  app.post('/api/bu/:slug/lab/kits/:kitId/check-in', async (request) => {
    const { slug, kitId } = kitParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['lab']);

    return withTenant(ctx.businessUnitId, async (tx) => {
      const [kit] = await tx.select().from(kits).where(eq(kits.id, kitId)).limit(1);
      if (!kit) throw notFound('Kit not found');
      if (kit.status !== 'sample_in_transit') {
        throw badRequest('This sample is not marked as in transit to the lab');
      }

      const actor = {
        businessUnitId: ctx.businessUnitId,
        actorRole: 'lab' as const,
        actorUserId: ctx.userId,
      };

      await setKitStatus(tx, actor, kitId, 'received_by_lab');
      await recordEvent(tx, {
        businessUnitId: ctx.businessUnitId,
        orderId: kit.orderId,
        kitId,
        actorUserId: ctx.userId,
        actorRole: 'lab',
        message: `Sample for kit #${kit.kitNumber} checked in at the lab`,
      });

      await tx
        .insert(labResults)
        .values({
          businessUnitId: ctx.businessUnitId,
          orderId: kit.orderId,
          kitId,
          labUserId: ctx.userId,
          receivedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: labResults.kitId,
          set: { receivedAt: new Date(), labUserId: ctx.userId },
        });

      await syncOrderFromKits(tx, actor, kit.orderId, 'All samples received by the lab');
      return { kitStatus: 'received_by_lab', orderId: kit.orderId };
    });
  });

  app.post('/api/bu/:slug/lab/kits/:kitId/start', async (request) => {
    const { slug, kitId } = kitParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['lab']);

    return withTenant(ctx.businessUnitId, async (tx) => {
      const [kit] = await tx.select().from(kits).where(eq(kits.id, kitId)).limit(1);
      if (!kit) throw notFound('Kit not found');
      if (kit.status !== 'received_by_lab') throw badRequest('This sample has not been checked in');

      const actor = {
        businessUnitId: ctx.businessUnitId,
        actorRole: 'lab' as const,
        actorUserId: ctx.userId,
      };

      await setKitStatus(tx, actor, kitId, 'processing');
      await recordEvent(tx, {
        businessUnitId: ctx.businessUnitId,
        orderId: kit.orderId,
        kitId,
        actorUserId: ctx.userId,
        actorRole: 'lab',
        message: `Analysis started for kit #${kit.kitNumber}`,
      });

      await syncOrderFromKits(tx, actor, kit.orderId, 'Lab analysis under way');
      return { kitStatus: 'processing', orderId: kit.orderId };
    });
  });

  /** Uploads the results PDF. Bytes go to PHI storage; only metadata is written to the database. */
  app.post('/api/bu/:slug/lab/orders/:orderId/files', async (request, reply) => {
    const { slug, orderId } = orderParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['lab']);

    const upload = await request.file();
    if (!upload) throw badRequest('No file was uploaded');
    if (!ACCEPTED_RESULT_TYPES.has(upload.mimetype)) {
      throw badRequest(`Unsupported file type "${upload.mimetype}". Upload a PDF.`);
    }

    const buffer = await upload.toBuffer();
    if (buffer.byteLength === 0) throw badRequest('The uploaded file is empty');

    const storageKey = generateStorageKey(ctx.businessUnitId, upload.filename);
    await storage.put(storageKey, buffer);

    const file = await withTenant(ctx.businessUnitId, async (tx) => {
      // Confirms the order is in this tenant before the file is attributed to it.
      await getOrderDetail(tx, ctx.businessUnitId, orderId);

      const [row] = await tx
        .insert(files)
        .values({
          businessUnitId: ctx.businessUnitId,
          storageKey,
          filename: upload.filename,
          mimeType: upload.mimetype,
          sizeBytes: buffer.byteLength,
          uploadedByUserId: ctx.userId,
        })
        .returning({
          id: files.id,
          filename: files.filename,
          mimeType: files.mimeType,
          sizeBytes: files.sizeBytes,
        });
      return row!;
    });

    return reply.status(201).send({ file });
  });

  /**
   * Marks one kit's analysis complete. When the last kit lands, the order is routed either to the
   * doctor queue or straight back to the patient, depending on the package.
   */
  app.post('/api/bu/:slug/lab/kits/:kitId/complete', async (request) => {
    const { slug, kitId } = kitParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['lab']);
    const input = completeAnalysisSchema.parse(request.body);

    const outcome = await withTenant(ctx.businessUnitId, async (tx) => {
      const [kit] = await tx.select().from(kits).where(eq(kits.id, kitId)).limit(1);
      if (!kit) throw notFound('Kit not found');
      if (!['received_by_lab', 'processing'].includes(kit.status)) {
        throw badRequest('This sample is not currently at the lab');
      }

      const [file] = await tx
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.id, input.fileId), eq(files.businessUnitId, ctx.businessUnitId)))
        .limit(1);
      if (!file) throw notFound('Result file not found');

      const actor = {
        businessUnitId: ctx.businessUnitId,
        actorRole: 'lab' as const,
        actorUserId: ctx.userId,
      };

      // The order must pass through `lab_processing` before it can reach `lab_complete`.
      if (kit.status === 'received_by_lab') {
        await setKitStatus(tx, actor, kitId, 'processing');
        await syncOrderFromKits(tx, actor, kit.orderId, 'Lab analysis under way');
      }

      await tx
        .insert(labResults)
        .values({
          businessUnitId: ctx.businessUnitId,
          orderId: kit.orderId,
          kitId,
          labUserId: ctx.userId,
          fileId: input.fileId,
          summary: input.summary,
          completedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: labResults.kitId,
          set: {
            fileId: input.fileId,
            summary: input.summary,
            completedAt: new Date(),
            labUserId: ctx.userId,
          },
        });

      await setKitStatus(tx, actor, kitId, 'lab_complete');
      await recordEvent(tx, {
        businessUnitId: ctx.businessUnitId,
        orderId: kit.orderId,
        kitId,
        actorUserId: ctx.userId,
        actorRole: 'lab',
        message: `Analysis complete for kit #${kit.kitNumber}`,
        metadata: { fileId: input.fileId },
      });

      const rolledUp = await syncOrderFromKits(
        tx,
        actor,
        kit.orderId,
        'Lab analysis complete for all kits',
      );

      if (rolledUp !== 'lab_complete') {
        return { orderId: kit.orderId, routedTo: null, intents: [] };
      }

      const routed = await routeAfterLabCompletion(tx, ctx.businessUnitId, kit.orderId);
      return { orderId: kit.orderId, routedTo: routed.routedTo, intents: routed.intents };
    });

    await dispatchNotifications(outcome.intents);
    return { kitStatus: 'lab_complete', orderId: outcome.orderId, routedTo: outcome.routedTo };
  });
}
