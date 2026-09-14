import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { externalPurchaseSchema } from '@nio/shared';
import { authProvider } from '../auth/index.js';
import { findPublicBusinessUnit } from '../auth/context.js';
import { withPlatformScope, withTenant } from '../db/client.js';
import { env } from '../env.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { generateOrderNumber } from '../lib/ids.js';
import {
  memberships,
  orders,
  packageTestTypes,
  packages,
  testTypes,
  users,
} from '../db/schema.js';
import { dispatchNotifications, sendInvitationEmail } from '../services/notifications.js';
import { dispatchPaidOrder } from '../services/paidOrder.js';
import { recordEvent } from '../services/orderWorkflow.js';

function requireIntegrationSecret(value: string | string[] | undefined): void {
  if (!env.INTEGRATION_API_SECRET) throw forbidden('External purchase ingestion is disabled');
  const supplied = Array.isArray(value) ? value[0] : value;
  if (!supplied) throw forbidden('Invalid integration credentials');
  const expectedBuffer = Buffer.from(env.INTEGRATION_API_SECRET);
  const suppliedBuffer = Buffer.from(supplied);
  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    throw forbidden('Invalid integration credentials');
  }
}

export async function integrationRoutes(app: FastifyInstance) {
  app.post(
    '/api/integrations/:slug/purchases',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      requireIntegrationSecret(request.headers['x-qinio-integration-key']);
      const { slug } = request.params as { slug: string };
      const input = externalPurchaseSchema.parse(request.body);
      const businessUnit = await findPublicBusinessUnit(slug);

      const existing = await withTenant(businessUnit.id, (tx) =>
        tx
          .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
          .from(orders)
          .where(
            and(
              eq(orders.orderSource, input.source),
              eq(orders.externalOrderId, input.externalOrderId),
            ),
          )
          .limit(1),
      );
      if (existing[0]) return { order: existing[0], replayed: true };

      const catalog = await withTenant(businessUnit.id, async (tx) => {
        const [pkg] = await tx
          .select()
          .from(packages)
          .where(
            and(
              eq(packages.externalProductId, input.packageReference),
              eq(packages.status, 'active'),
            ),
          )
          .limit(1);
        if (!pkg) throw notFound('Active package reference not found');
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
        return { pkg, composition };
      });

      const invited = await authProvider().inviteUser({
        orgId: businessUnit.auth0OrgId,
        email: input.patient.email,
        name: input.patient.name,
        loginPath: `/login?org=${encodeURIComponent(slug)}&returnTo=${encodeURIComponent('/portal/orders')}`,
      });
      if (invited.signInUrl) {
        await sendInvitationEmail({
          email: input.patient.email,
          name: input.patient.name,
          passwordSetUrl: invited.passwordSetUrl,
          signInUrl: invited.signInUrl,
          workspaceName: businessUnit.name,
          roleLabel: 'Patient',
        });
      }

      const patient = await withPlatformScope(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            email: input.patient.email,
            name: input.patient.name,
            auth0UserId: invited.subject,
            status: 'active',
          })
          .onConflictDoUpdate({
            target: users.email,
            set: { name: input.patient.name, status: 'active' },
          })
          .returning();
        if (user!.auth0UserId !== invited.subject) {
          throw conflict('Patient email is bound to another identity');
        }
        await tx
          .insert(memberships)
          .values({
            businessUnitId: businessUnit.id,
            userId: user!.id,
            role: 'patient',
            status: 'active',
          })
          .onConflictDoNothing();
        return user!;
      });

      const result = await withTenant(businessUnit.id, async (tx) => {
        const { pkg, composition } = catalog;

        const [order] = await tx
          .insert(orders)
          .values({
            businessUnitId: businessUnit.id,
            orderNumber: generateOrderNumber(),
            patientUserId: patient.id,
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
            orderSource: input.source,
            externalOrderId: input.externalOrderId,
            externalPaymentId: input.externalPaymentId,
            shippingAddress: input.shippingAddress,
            shippingMethod: input.shippingMethod,
            requiresClinician: pkg.requiresClinician,
          })
          .onConflictDoNothing()
          .returning();

        if (!order) {
          const [replayed] = await tx
            .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
            .from(orders)
            .where(
              and(
                eq(orders.orderSource, input.source),
                eq(orders.externalOrderId, input.externalOrderId),
              ),
            )
            .limit(1);
          return { order: replayed!, replayed: true, intents: [] };
        }

        await recordEvent(tx, {
          businessUnitId: businessUnit.id,
          orderId: order.id,
          actorUserId: null,
          actorRole: 'system',
          toStatus: 'pending_payment',
          message: `External purchase received from ${input.source}`,
          metadata: { externalOrderId: input.externalOrderId },
        });
        const intents = await dispatchPaidOrder(tx, {
          businessUnitId: businessUnit.id,
          order,
          paymentReference: input.externalPaymentId,
          actorRole: 'system',
          actorUserId: null,
        });
        return { order, replayed: false, intents };
      });

      await dispatchNotifications(result.intents);
      return reply.status(result.replayed ? 200 : 201).send({
        order: {
          id: result.order.id,
          orderNumber: result.order.orderNumber,
          status: result.replayed ? result.order.status : 'dispatched_to_fulfillment',
        },
        replayed: result.replayed,
      });
    },
  );
}
