import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { workspacePath } from '@nio/shared';
import { requireMembership } from '../auth/context.js';
import { withPlatformScope, withTenant } from '../db/client.js';
import { env } from '../env.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import {
  businessUnits,
  packagePaymentMappings,
  packages,
  paymentAccounts,
  payments,
  orders,
} from '../db/schema.js';
import {
  connectAuthorizeUrl,
  createStripeRefund,
  disconnectConnectAccount,
  exchangeConnectCode,
  hashOAuthState,
  newOAuthState,
  queueCatalogSync,
  refreshConnectAccount,
  stripeEnabled,
  stripeClient,
  syncPackageCatalog,
} from '../services/stripe.js';
import { dispatchPaidOrder } from '../services/paidOrder.js';
import { dispatchNotifications } from '../services/notifications.js';

const slugParam = z.object({ slug: z.string() });
const paymentParam = slugParam.extend({ paymentId: z.uuid() });

export async function paymentRoutes(app: FastifyInstance) {
  app.get('/api/bu/:slug/payments/config', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    return withTenant(ctx, async (tx) => {
      const [account] = await tx
        .select()
        .from(paymentAccounts)
        .where(eq(paymentAccounts.provider, 'stripe'))
        .limit(1);
      const mappings = await tx
        .select({
          packageId: packages.id,
          packageName: packages.name,
          packageVersion: packages.version,
          packageStatus: packages.status,
          syncStatus: packagePaymentMappings.status,
          productId: packagePaymentMappings.providerProductId,
          priceId: packagePaymentMappings.providerPriceId,
          error: packagePaymentMappings.lastError,
        })
        .from(packages)
        .leftJoin(
          packagePaymentMappings,
          and(
            eq(packagePaymentMappings.packageId, packages.id),
            eq(packagePaymentMappings.provider, 'stripe'),
          ),
        )
        .orderBy(packages.name, desc(packages.version));
      const accountId = account?.providerAccountId ?? null;
      const livemode = env.STRIPE_SECRET_KEY?.startsWith('sk_live_') ?? false;
      const dashboardBase = livemode
        ? 'https://dashboard.stripe.com'
        : 'https://dashboard.stripe.com/test';

      return {
        provider: env.PAYMENT_PROVIDER,
        livemode,
        webhookPath: '/api/webhooks/stripe',
        account: account
          ? {
              status: account.status,
              accountId,
              chargesEnabled: account.chargesEnabled,
              payoutsEnabled: account.payoutsEnabled,
              detailsSubmitted: account.detailsSubmitted,
              disabledReason: account.disabledReason,
              country: account.country,
              defaultCurrency: account.defaultCurrency,
              lastSyncError: account.lastSyncError,
            }
          : null,
        mappings,
        dashboardUrl: accountId ? `${dashboardBase}/connect/accounts/${accountId}` : null,
      };
    });
  });

  app.post('/api/bu/:slug/payments/connect', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    if (!stripeEnabled()) throw badRequest('Set PAYMENT_PROVIDER=stripe before connecting Stripe');
    const [existing] = await withTenant(ctx, (tx) =>
      tx
        .select({ providerAccountId: paymentAccounts.providerAccountId })
        .from(paymentAccounts)
        .where(eq(paymentAccounts.provider, 'stripe'))
        .limit(1),
    );
    if (existing?.providerAccountId) {
      throw conflict('A Stripe account is already connected to this business unit');
    }
    const state = newOAuthState();
    await withTenant(ctx, (tx) =>
      tx
        .insert(paymentAccounts)
        .values({
          businessUnitId: ctx.businessUnitId,
          provider: 'stripe',
          status: 'pending',
          oauthStateHash: hashOAuthState(state),
          oauthStateExpiresAt: new Date(Date.now() + 15 * 60_000),
        })
        .onConflictDoUpdate({
          target: [paymentAccounts.businessUnitId, paymentAccounts.provider],
          set: {
            status: 'pending',
            oauthStateHash: hashOAuthState(state),
            oauthStateExpiresAt: new Date(Date.now() + 15 * 60_000),
            updatedAt: new Date(),
          },
        }),
    );
    return { url: connectAuthorizeUrl(state) };
  });

  app.get('/api/payments/stripe/callback', async (request, reply) => {
    const query = z
      .object({
        code: z.string().optional(),
        state: z.string(),
        error: z.string().optional(),
      })
      .parse(request.query);
    const stateHash = hashOAuthState(query.state);
    const record = await withPlatformScope(async (tx) => {
      const [row] = await tx
        .select({
          id: paymentAccounts.id,
          businessUnitId: paymentAccounts.businessUnitId,
          expiresAt: paymentAccounts.oauthStateExpiresAt,
          slug: businessUnits.slug,
        })
        .from(paymentAccounts)
        .innerJoin(businessUnits, eq(businessUnits.id, paymentAccounts.businessUnitId))
        .where(eq(paymentAccounts.oauthStateHash, stateHash))
        .limit(1);
      return row;
    });
    if (!record || !record.expiresAt || record.expiresAt.getTime() < Date.now()) {
      throw badRequest('Stripe connection state is invalid or expired');
    }
    if (query.error || !query.code) {
      await withPlatformScope((tx) =>
        tx
          .update(paymentAccounts)
          .set({
            status: 'disconnected',
            oauthStateHash: null,
            oauthStateExpiresAt: null,
            lastSyncError: 'Stripe authorization was cancelled',
            updatedAt: new Date(),
          })
          .where(eq(paymentAccounts.id, record.id)),
      );
      return reply.redirect(
        `${env.WEB_ORIGIN}${workspacePath(record.slug, 'bu_admin', '/payments')}?connection=cancelled`,
      );
    }

    const accountId = await exchangeConnectCode(query.code);
    await withPlatformScope((tx) =>
      tx
        .update(paymentAccounts)
        .set({
          providerAccountId: accountId,
          status: 'pending',
          oauthStateHash: null,
          oauthStateExpiresAt: null,
          disconnectedAt: null,
          lastSyncError: null,
          updatedAt: new Date(),
        })
        .where(eq(paymentAccounts.id, record.id)),
    );
    await refreshConnectAccount(record.businessUnitId, accountId);
    const packageIds = await withTenant(record.businessUnitId, async (tx) => {
      const rows = await tx.select({ id: packages.id }).from(packages);
      for (const pkg of rows) {
        await queueCatalogSync(tx, record.businessUnitId, pkg.id);
      }
      return rows.map((pkg) => pkg.id);
    });
    for (const packageId of packageIds) {
      await syncPackageCatalog(record.businessUnitId, packageId);
    }
    return reply.redirect(
      `${env.WEB_ORIGIN}${workspacePath(record.slug, 'bu_admin', '/payments')}?connection=complete`,
    );
  });

  app.post('/api/bu/:slug/payments/disconnect', async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    const [account] = await withTenant(ctx, (tx) =>
      tx.select().from(paymentAccounts).where(eq(paymentAccounts.provider, 'stripe')).limit(1),
    );
    if (!account?.providerAccountId) throw notFound('No Stripe account is connected');
    const [existingPayment] = await withTenant(ctx, (tx) =>
      tx.select({ id: payments.id }).from(payments).where(eq(payments.provider, 'stripe')).limit(1),
    );
    if (existingPayment) {
      throw conflict('A Stripe account with payment history cannot be disconnected');
    }
    await disconnectConnectAccount(account.providerAccountId);
    await withTenant(ctx, (tx) =>
      tx
        .update(paymentAccounts)
        .set({
          providerAccountId: null,
          status: 'disconnected',
          chargesEnabled: false,
          payoutsEnabled: false,
          detailsSubmitted: false,
          disconnectedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(paymentAccounts.id, account.id)),
    );
    return reply.status(204).send();
  });

  app.post('/api/bu/:slug/payments/refresh', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    const [account] = await withTenant(ctx, (tx) =>
      tx.select().from(paymentAccounts).where(eq(paymentAccounts.provider, 'stripe')).limit(1),
    );
    if (!account?.providerAccountId) throw notFound('No Stripe account is connected');
    await refreshConnectAccount(ctx.businessUnitId, account.providerAccountId);
    return { refreshed: true };
  });

  app.post('/api/bu/:slug/payments/packages/:packageId/sync', async (request) => {
    const { slug, packageId } = z
      .object({ slug: z.string(), packageId: z.uuid() })
      .parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    await withTenant(ctx, (tx) => queueCatalogSync(tx, ctx.businessUnitId, packageId));
    return { sync: await syncPackageCatalog(ctx.businessUnitId, packageId) };
  });

  app.get('/api/bu/:slug/payments', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    return withTenant(ctx, async (tx) => ({
      payments: await tx
        .select({
          id: payments.id,
          orderId: payments.orderId,
          orderNumber: orders.orderNumber,
          status: payments.status,
          amountCents: payments.amountCents,
          refundedCents: payments.refundedCents,
          disputedCents: payments.disputedCents,
          currency: payments.currency,
          paymentIntentId: payments.paymentIntentId,
          failureMessage: payments.failureMessage,
          createdAt: payments.createdAt,
        })
        .from(payments)
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .orderBy(desc(payments.createdAt)),
    }));
  });

  app.post('/api/bu/:slug/payments/:paymentId/refund', async (request) => {
    const { slug, paymentId } = paymentParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    const { amountCents } = z
      .object({ amountCents: z.coerce.number().int().positive().optional() })
      .parse(request.body ?? {});
    const [payment] = await withTenant(ctx, (tx) =>
      tx.select().from(payments).where(eq(payments.id, paymentId)).limit(1),
    );
    if (!payment?.providerAccountId || !payment.paymentIntentId) {
      throw conflict('This payment cannot be refunded through Stripe');
    }
    const remaining = payment.amountCents - payment.refundedCents;
    if (amountCents && amountCents > remaining) throw badRequest('Refund exceeds remaining amount');
    const refund = await createStripeRefund({
      providerAccountId: payment.providerAccountId,
      paymentIntentId: payment.paymentIntentId,
      paymentId: payment.id,
      amountCents,
      refundedCents: payment.refundedCents,
    });
    return { refund: { id: refund.id, status: refund.status, amountCents: refund.amount } };
  });

  app.post('/api/bu/:slug/payments/:paymentId/reconcile', async (request) => {
    const { slug, paymentId } = paymentParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    const [payment] = await withTenant(ctx, (tx) =>
      tx.select().from(payments).where(eq(payments.id, paymentId)).limit(1),
    );
    if (!payment?.providerAccountId || !payment.checkoutSessionId) {
      throw conflict('This payment has no Stripe Checkout session');
    }
    const session = await stripeClient().checkout.sessions.retrieve(
      payment.checkoutSessionId,
      {},
      { stripeAccount: payment.providerAccountId },
    );
    const paymentIntentId =
      typeof session.payment_intent === 'string' ? session.payment_intent : null;
    const intents = await withTenant(ctx, async (tx) => {
      if (session.payment_status === 'paid') {
        await tx
          .update(payments)
          .set({
            status: 'paid',
            paymentIntentId,
            paidAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(payments.id, payment.id));
        const [order] = await tx
          .select()
          .from(orders)
          .where(eq(orders.id, payment.orderId))
          .limit(1);
        if (order?.status === 'pending_payment') {
          return dispatchPaidOrder(tx, {
            businessUnitId: ctx.businessUnitId,
            order,
            paymentReference: paymentIntentId ?? session.id,
            actorRole: 'system',
            actorUserId: null,
          });
        }
      } else if (session.status === 'expired') {
        await tx
          .update(payments)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(payments.id, payment.id));
        await tx
          .update(orders)
          .set({ paymentStatus: 'expired', updatedAt: new Date() })
          .where(eq(orders.id, payment.orderId));
      }
      return [];
    });
    await dispatchNotifications(intents);
    return {
      payment: {
        id: payment.id,
        checkoutStatus: session.status,
        paymentStatus: session.payment_status,
      },
    };
  });
}
