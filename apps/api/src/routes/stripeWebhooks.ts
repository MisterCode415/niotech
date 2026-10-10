import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { withTenant } from '../db/client.js';
import { env } from '../env.js';
import {
  orders,
  paymentEvents,
  payments,
  memberships,
  users,
  packagePaymentMappings,
  packages,
} from '../db/schema.js';
import { dispatchNotifications, type NotificationIntent } from '../services/notifications.js';
import { dispatchPaidOrder } from '../services/paidOrder.js';
import { recordEvent } from '../services/orderWorkflow.js';
import {
  findPaymentAccountByProviderId,
  refreshConnectAccount,
  stripeClient,
} from '../services/stripe.js';

type RawRequest = FastifyRequest & { rawBody?: Buffer };

function safeEventPayload(event: Stripe.Event): Record<string, unknown> {
  const object = event.data.object as { id?: string; status?: string };
  return {
    objectId: object.id ?? null,
    status: object.status ?? null,
    created: event.created,
  };
}

export async function stripeWebhookRoutes(app: FastifyInstance) {
  app.post('/api/webhooks/stripe', { config: { rawBody: true } }, async (request, reply) => {
    if (!env.STRIPE_WEBHOOK_SECRET) return reply.status(503).send({ error: 'Stripe disabled' });
    const signature = request.headers['stripe-signature'];
    const rawBody = (request as RawRequest).rawBody;
    if (typeof signature !== 'string' || !rawBody) {
      return reply.status(400).send({ error: 'Missing Stripe signature' });
    }

    let event: Stripe.Event;
    try {
      event = stripeClient().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      return reply.status(400).send({ error: 'Invalid Stripe signature' });
    }

    const accountId =
      typeof event.account === 'string'
        ? event.account
        : event.type === 'account.updated'
          ? (event.data.object as Stripe.Account).id
          : null;
    if (!accountId) return reply.status(200).send({ received: true, ignored: true });
    const account = await findPaymentAccountByProviderId(accountId);
    if (!account) return reply.status(200).send({ received: true, ignored: true });

    if (event.type === 'account.updated') {
      await refreshConnectAccount(account.businessUnitId, accountId);
    }

    const intents: NotificationIntent[] = [];
    await withTenant(account.businessUnitId, async (tx) => {
      let paymentId: string | null = null;
      let payment: typeof payments.$inferSelect | undefined;
      const object = event.data.object;

      if (event.type.startsWith('checkout.session.') && object.object === 'checkout.session') {
        const session = object as Stripe.Checkout.Session;
        [payment] = await tx
          .select()
          .from(payments)
          .where(eq(payments.checkoutSessionId, session.id))
          .limit(1);
      } else if (object.object === 'payment_intent') {
        const intent = object as Stripe.PaymentIntent;
        [payment] = await tx
          .select()
          .from(payments)
          .where(eq(payments.paymentIntentId, intent.id))
          .limit(1);
      } else if (object.object === 'charge') {
        const charge = object as Stripe.Charge;
        const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
        if (intentId) {
          [payment] = await tx
            .select()
            .from(payments)
            .where(eq(payments.paymentIntentId, intentId))
            .limit(1);
        }
      } else if (object.object === 'dispute') {
        const dispute = object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id;
        [payment] = await tx
          .select()
          .from(payments)
          .where(eq(payments.chargeId, chargeId))
          .limit(1);
        if (!payment) {
          const charge = await stripeClient().charges.retrieve(
            chargeId,
            {},
            { stripeAccount: accountId },
          );
          const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
          if (intentId) {
            [payment] = await tx
              .select()
              .from(payments)
              .where(eq(payments.paymentIntentId, intentId))
              .limit(1);
          }
        }
      }

      if (!payment && 'metadata' in object) {
        const metadata = (object as { metadata?: Record<string, string> }).metadata;
        const orderId = metadata?.qinio_order_id;
        if (orderId) {
          [payment] = await tx
            .select()
            .from(payments)
            .where(and(eq(payments.orderId, orderId), eq(payments.provider, 'stripe')))
            .limit(1);
        }
      }

      if (payment && payment.providerAccountId !== accountId) {
        throw new Error('Stripe event account does not match payment account');
      }
      paymentId = payment?.id ?? null;

      const inserted = await tx
        .insert(paymentEvents)
        .values({
          businessUnitId: account.businessUnitId,
          paymentId,
          provider: 'stripe',
          providerEventId: event.id,
          eventType: event.type,
          livemode: event.livemode,
          payload: safeEventPayload(event),
        })
        .onConflictDoNothing()
        .returning({ id: paymentEvents.id });
      if (inserted.length === 0) return;

      if (object.object === 'product') {
        const product = object as Stripe.Product;
        const mappings = await tx
          .select({
            mappingId: packagePaymentMappings.id,
            name: packages.name,
            description: packages.description,
            packageStatus: packages.status,
          })
          .from(packagePaymentMappings)
          .innerJoin(packages, eq(packages.id, packagePaymentMappings.packageId))
          .where(eq(packagePaymentMappings.providerProductId, product.id));
        for (const mapping of mappings) {
          const drifted =
            mapping.packageStatus !== 'archived' &&
            (product.name !== mapping.name ||
              (product.description ?? null) !== mapping.description ||
              !product.active);
          if (drifted) {
            await tx
              .update(packagePaymentMappings)
              .set({
                status: 'failed',
                lastError: 'Stripe product changed outside Qinio; resync required',
                updatedAt: new Date(),
              })
              .where(eq(packagePaymentMappings.id, mapping.mappingId));
          }
        }
      } else if (object.object === 'price') {
        const price = object as Stripe.Price;
        const [mapping] = await tx
          .select({
            mappingId: packagePaymentMappings.id,
            amount: packages.priceCents,
            packageStatus: packages.status,
          })
          .from(packagePaymentMappings)
          .innerJoin(packages, eq(packages.id, packagePaymentMappings.packageId))
          .where(eq(packagePaymentMappings.providerPriceId, price.id))
          .limit(1);
        if (
          mapping &&
          (price.unit_amount !== mapping.amount ||
            price.currency !== env.STRIPE_CURRENCY ||
            price.active !== (mapping.packageStatus !== 'archived'))
        ) {
          await tx
            .update(packagePaymentMappings)
            .set({
              status: 'failed',
              lastError: 'Stripe price changed outside Qinio; resync required',
              updatedAt: new Date(),
            })
            .where(eq(packagePaymentMappings.id, mapping.mappingId));
        }
      } else if (payment && object.object === 'checkout.session') {
        const session = object as Stripe.Checkout.Session;
        const paymentIntentId =
          typeof session.payment_intent === 'string' ? session.payment_intent : null;
        if (
          event.type === 'checkout.session.completed' ||
          event.type === 'checkout.session.async_payment_succeeded'
        ) {
          if (session.payment_status === 'paid' || event.type.endsWith('succeeded')) {
            if (
              session.amount_total !== payment.amountCents ||
              session.currency !== payment.currency
            ) {
              throw new Error('Stripe payment amount or currency does not match the order');
            }
            await tx
              .update(payments)
              .set({
                status: 'paid',
                paymentIntentId,
                paidAt: new Date(event.created * 1000),
                updatedAt: new Date(),
              })
              .where(eq(payments.id, payment.id));
            const [order] = await tx
              .select()
              .from(orders)
              .where(eq(orders.id, payment.orderId))
              .limit(1);
            if (order?.status === 'pending_payment') {
              intents.push(
                ...(await dispatchPaidOrder(tx, {
                  businessUnitId: account.businessUnitId,
                  order,
                  paymentReference: paymentIntentId ?? session.id,
                  actorRole: 'system',
                  actorUserId: null,
                })),
              );
            }
          } else {
            await tx
              .update(payments)
              .set({ status: 'processing', paymentIntentId, updatedAt: new Date() })
              .where(eq(payments.id, payment.id));
            await tx
              .update(orders)
              .set({ paymentStatus: 'processing', updatedAt: new Date() })
              .where(eq(orders.id, payment.orderId));
          }
        } else if (event.type === 'checkout.session.async_payment_failed') {
          await tx
            .update(payments)
            .set({ status: 'failed', updatedAt: new Date() })
            .where(eq(payments.id, payment.id));
          await tx
            .update(orders)
            .set({ paymentStatus: 'failed', updatedAt: new Date() })
            .where(eq(orders.id, payment.orderId));
          await recordEvent(tx, {
            businessUnitId: account.businessUnitId,
            orderId: payment.orderId,
            actorUserId: null,
            actorRole: 'system',
            message: 'Stripe reported that payment failed',
            metadata: { providerEventId: event.id },
          });
        } else if (event.type === 'checkout.session.expired') {
          await tx
            .update(payments)
            .set({ status: 'expired', updatedAt: new Date() })
            .where(eq(payments.id, payment.id));
          await tx
            .update(orders)
            .set({ paymentStatus: 'expired', updatedAt: new Date() })
            .where(eq(orders.id, payment.orderId));
          await recordEvent(tx, {
            businessUnitId: account.businessUnitId,
            orderId: payment.orderId,
            actorUserId: null,
            actorRole: 'system',
            message: 'Stripe Checkout session expired',
            metadata: { providerEventId: event.id },
          });
        }
      } else if (payment && object.object === 'payment_intent') {
        const intent = object as Stripe.PaymentIntent;
        if (event.type === 'payment_intent.succeeded') {
          if (
            intent.amount_received !== payment.amountCents ||
            intent.currency !== payment.currency
          ) {
            throw new Error('Stripe payment amount or currency does not match the order');
          }
          await tx
            .update(payments)
            .set({
              status: 'paid',
              paymentIntentId: intent.id,
              chargeId: typeof intent.latest_charge === 'string' ? intent.latest_charge : null,
              paidAt: new Date(event.created * 1000),
              updatedAt: new Date(),
            })
            .where(eq(payments.id, payment.id));
          const [order] = await tx
            .select()
            .from(orders)
            .where(eq(orders.id, payment.orderId))
            .limit(1);
          if (order?.status === 'pending_payment') {
            intents.push(
              ...(await dispatchPaidOrder(tx, {
                businessUnitId: account.businessUnitId,
                order,
                paymentReference: intent.id,
                actorRole: 'system',
                actorUserId: null,
              })),
            );
          }
        } else if (event.type === 'payment_intent.payment_failed') {
          await tx
            .update(payments)
            .set({
              status: 'failed',
              failureCode: intent.last_payment_error?.code ?? null,
              failureMessage: intent.last_payment_error?.decline_code ?? 'Payment failed',
              updatedAt: new Date(),
            })
            .where(eq(payments.id, payment.id));
          await tx
            .update(orders)
            .set({ paymentStatus: 'failed', updatedAt: new Date() })
            .where(eq(orders.id, payment.orderId));
          await recordEvent(tx, {
            businessUnitId: account.businessUnitId,
            orderId: payment.orderId,
            actorUserId: null,
            actorRole: 'system',
            message: 'Stripe declined the payment',
            metadata: {
              providerEventId: event.id,
              failureCode: intent.last_payment_error?.code ?? null,
            },
          });
        }
      } else if (payment && object.object === 'charge') {
        const charge = object as Stripe.Charge;
        await tx
          .update(payments)
          .set({
            chargeId: charge.id,
            refundedCents: charge.amount_refunded,
            status:
              charge.amount_refunded >= charge.amount
                ? 'refunded'
                : charge.amount_refunded > 0
                  ? 'partially_refunded'
                  : payment.status,
            updatedAt: new Date(),
          })
          .where(eq(payments.id, payment.id));
        if (charge.amount_refunded > 0) {
          await tx
            .update(orders)
            .set({
              paymentStatus:
                charge.amount_refunded >= charge.amount ? 'refunded' : 'partially_refunded',
              updatedAt: new Date(),
            })
            .where(eq(orders.id, payment.orderId));
          await recordEvent(tx, {
            businessUnitId: account.businessUnitId,
            orderId: payment.orderId,
            actorUserId: null,
            actorRole: 'system',
            message:
              charge.amount_refunded >= charge.amount
                ? 'Stripe payment fully refunded'
                : 'Stripe payment partially refunded',
            metadata: {
              providerEventId: event.id,
              refundedCents: charge.amount_refunded,
            },
          });
        }
      } else if (payment && object.object === 'dispute') {
        const dispute = object as Stripe.Dispute;
        const isWon = event.type === 'charge.dispute.closed' && dispute.status === 'won';
        await tx
          .update(payments)
          .set({
            status: isWon ? 'paid' : 'disputed',
            disputedCents: isWon ? 0 : dispute.amount,
            chargeId: typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id,
            updatedAt: new Date(),
          })
          .where(eq(payments.id, payment.id));
        await tx
          .update(orders)
          .set({ paymentStatus: isWon ? 'paid' : 'disputed', updatedAt: new Date() })
          .where(eq(orders.id, payment.orderId));
        await recordEvent(tx, {
          businessUnitId: account.businessUnitId,
          orderId: payment.orderId,
          actorUserId: null,
          actorRole: 'system',
          message: isWon ? 'Stripe payment dispute won' : 'Stripe payment disputed',
          metadata: {
            providerEventId: event.id,
            disputeStatus: dispute.status,
            disputedCents: dispute.amount,
          },
        });

        const admins = await tx
          .select({ userId: users.id, email: users.email })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(eq(memberships.role, 'bu_admin'), eq(memberships.status, 'active')));
        intents.push(
          ...admins.map((admin) => ({
            businessUnitId: account.businessUnitId,
            userId: admin.userId,
            email: admin.email,
            type: 'payment_dispute',
            title: isWon ? 'Payment dispute resolved' : 'Payment dispute opened',
            body: isWon
              ? 'Stripe reports that a payment dispute was won.'
              : 'A Stripe payment was disputed. Review it in the Stripe Dashboard.',
            orderId: payment.orderId,
          })),
        );
      }

      await tx
        .update(paymentEvents)
        .set({ processedAt: new Date(), paymentId })
        .where(
          and(eq(paymentEvents.provider, 'stripe'), eq(paymentEvents.providerEventId, event.id)),
        );
    });

    await dispatchNotifications(intents);
    return reply.status(200).send({ received: true });
  });
}
