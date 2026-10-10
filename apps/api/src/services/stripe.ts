import { createHash, randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { and, eq, lte, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { withPlatformScope, withTenant } from '../db/client.js';
import { env } from '../env.js';
import { badRequest, conflict } from '../lib/errors.js';
import {
  catalogSyncJobs,
  packagePaymentMappings,
  packages,
  paymentAccounts,
  payments,
  orders,
} from '../db/schema.js';

let client: Stripe | null = null;

export function stripeEnabled(): boolean {
  return env.PAYMENT_PROVIDER === 'stripe';
}

export function stripeClient(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw badRequest('Stripe is not configured');
  client ??= new Stripe(env.STRIPE_SECRET_KEY);
  return client;
}

export function hashOAuthState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export function newOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export function connectAuthorizeUrl(state: string): string {
  if (!env.STRIPE_CONNECT_CLIENT_ID) throw badRequest('Stripe Connect is not configured');
  const url = new URL('https://connect.stripe.com/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.STRIPE_CONNECT_CLIENT_ID);
  url.searchParams.set('scope', 'read_write');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', `${env.API_PUBLIC_URL}/api/payments/stripe/callback`);
  return url.toString();
}

export async function exchangeConnectCode(code: string): Promise<string> {
  const response = await stripeClient().oauth.token({
    grant_type: 'authorization_code',
    code,
  });
  if (!response.stripe_user_id) throw badRequest('Stripe did not return a connected account');
  return response.stripe_user_id;
}

export async function disconnectConnectAccount(accountId: string): Promise<void> {
  if (!env.STRIPE_CONNECT_CLIENT_ID) throw badRequest('Stripe Connect is not configured');
  await stripeClient().oauth.deauthorize({
    client_id: env.STRIPE_CONNECT_CLIENT_ID,
    stripe_user_id: accountId,
  });
}

export async function refreshConnectAccount(
  businessUnitId: string,
  accountId: string,
): Promise<{ chargesEnabled: boolean }> {
  const account = await stripeClient().accounts.retrieve(accountId);
  const disabledReason =
    account.requirements?.disabled_reason ?? account.future_requirements?.disabled_reason ?? null;
  const status =
    account.charges_enabled && account.details_submitted
      ? 'active'
      : account.details_submitted
        ? 'restricted'
        : 'pending';

  await withTenant(businessUnitId, (tx) =>
    tx
      .update(paymentAccounts)
      .set({
        status,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
        country: account.country ?? null,
        defaultCurrency: account.default_currency ?? null,
        disabledReason,
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentAccounts.businessUnitId, businessUnitId),
          eq(paymentAccounts.provider, 'stripe'),
        ),
      ),
  );
  return { chargesEnabled: account.charges_enabled };
}

export async function queueCatalogSync(
  tx: Tx,
  businessUnitId: string,
  packageId: string,
): Promise<void> {
  await tx
    .insert(packagePaymentMappings)
    .values({ businessUnitId, packageId, provider: 'stripe', status: 'pending' })
    .onConflictDoUpdate({
      target: [packagePaymentMappings.packageId, packagePaymentMappings.provider],
      set: { status: 'pending', lastError: null, updatedAt: new Date() },
    });
  await tx
    .insert(catalogSyncJobs)
    .values({ businessUnitId, packageId, provider: 'stripe', status: 'pending' })
    .onConflictDoUpdate({
      target: [catalogSyncJobs.packageId, catalogSyncJobs.provider],
      set: {
        status: 'pending',
        lastError: null,
        nextAttemptAt: new Date(),
        completedAt: null,
        updatedAt: new Date(),
      },
    });
}

export async function syncPackageCatalog(
  businessUnitId: string,
  packageId: string,
): Promise<{ status: 'synced' | 'pending' | 'failed'; error?: string }> {
  if (!stripeEnabled()) return { status: 'pending' };

  const loaded = await withTenant(businessUnitId, async (tx) => {
    const [account] = await tx
      .select()
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.businessUnitId, businessUnitId),
          eq(paymentAccounts.provider, 'stripe'),
        ),
      )
      .limit(1);
    const [pkg] = await tx.select().from(packages).where(eq(packages.id, packageId)).limit(1);
    if (!pkg) throw badRequest('Package not found');
    const [mapping] = await tx
      .select()
      .from(packagePaymentMappings)
      .where(
        and(
          eq(packagePaymentMappings.packageId, packageId),
          eq(packagePaymentMappings.provider, 'stripe'),
        ),
      )
      .limit(1);
    let predecessorProductId: string | null = null;
    if (pkg.supersedesPackageId) {
      const [predecessor] = await tx
        .select({ providerProductId: packagePaymentMappings.providerProductId })
        .from(packagePaymentMappings)
        .where(
          and(
            eq(packagePaymentMappings.packageId, pkg.supersedesPackageId),
            eq(packagePaymentMappings.provider, 'stripe'),
          ),
        )
        .limit(1);
      predecessorProductId = predecessor?.providerProductId ?? null;
    }
    return { account, pkg, mapping, predecessorProductId };
  });

  if (!loaded.account?.providerAccountId) {
    const message = 'Connect a Stripe account before synchronizing packages';
    await withTenant(businessUnitId, (tx) =>
      tx
        .update(packagePaymentMappings)
        .set({ status: 'pending', lastError: message, updatedAt: new Date() })
        .where(eq(packagePaymentMappings.packageId, packageId)),
    );
    return { status: 'pending', error: message };
  }

  await withTenant(businessUnitId, async (tx) => {
    await tx
      .update(packagePaymentMappings)
      .set({ status: 'syncing', lastError: null, updatedAt: new Date() })
      .where(eq(packagePaymentMappings.packageId, packageId));
    await tx
      .update(catalogSyncJobs)
      .set({
        status: 'syncing',
        attempts: sql`${catalogSyncJobs.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(catalogSyncJobs.packageId, packageId));
  });

  const stripeAccount = loaded.account.providerAccountId;
  try {
    let productId = loaded.mapping?.providerProductId ?? loaded.predecessorProductId;
    if (!productId) {
      const product = await stripeClient().products.create(
        {
          name: loaded.pkg.name,
          description: loaded.pkg.description ?? undefined,
          active: true,
          metadata: { qinio_package_lineage: loaded.pkg.id },
        },
        {
          stripeAccount,
          idempotencyKey: `qinio-product-${loaded.pkg.id}`,
        },
      );
      productId = product.id;
    } else if (loaded.pkg.status !== 'archived') {
      await stripeClient().products.update(
        productId,
        {
          name: loaded.pkg.name,
          description: loaded.pkg.description ?? '',
          active: true,
        },
        { stripeAccount },
      );
    }

    let priceId = loaded.mapping?.providerPriceId;
    let replacePrice = !priceId;
    if (priceId) {
      const existingPrice = await stripeClient().prices.retrieve(priceId, {}, { stripeAccount });
      replacePrice =
        existingPrice.unit_amount !== loaded.pkg.priceCents ||
        existingPrice.currency !== env.STRIPE_CURRENCY ||
        (typeof existingPrice.product === 'string'
          ? existingPrice.product
          : existingPrice.product.id) !== productId;
    }
    if (replacePrice) {
      const price = await stripeClient().prices.create(
        {
          product: productId,
          currency: env.STRIPE_CURRENCY,
          unit_amount: loaded.pkg.priceCents,
          metadata: {
            qinio_package_id: loaded.pkg.id,
            qinio_package_version: String(loaded.pkg.version),
          },
        },
        {
          stripeAccount,
          idempotencyKey:
            `qinio-price-${loaded.pkg.id}-${loaded.pkg.version}-` +
            `${loaded.pkg.priceCents}-${env.STRIPE_CURRENCY}`,
        },
      );
      if (priceId) {
        await stripeClient().prices.update(priceId, { active: false }, { stripeAccount });
      }
      priceId = price.id;
    } else {
      await stripeClient().prices.update(
        priceId!,
        { active: loaded.pkg.status !== 'archived' },
        { stripeAccount },
      );
    }

    await withTenant(businessUnitId, async (tx) => {
      await tx
        .update(packagePaymentMappings)
        .set({
          providerProductId: productId,
          providerPriceId: priceId,
          status: 'synced',
          lastError: null,
          syncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(packagePaymentMappings.packageId, packageId));
      await tx
        .update(catalogSyncJobs)
        .set({
          status: 'synced',
          lastError: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(catalogSyncJobs.packageId, packageId));
    });
    let chargesEnabled = loaded.account.chargesEnabled;
    if (!chargesEnabled) {
      // account.updated webhooks can lag or never arrive (e.g. localhost), so ask Stripe directly.
      ({ chargesEnabled } = await refreshConnectAccount(businessUnitId, stripeAccount).catch(
        () => ({ chargesEnabled: false }),
      ));
    }
    if (!chargesEnabled) {
      return {
        status: 'pending',
        error: 'Complete Stripe onboarding before activating this package',
      };
    }
    return { status: 'synced' };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : 'Stripe synchronization failed';
    await withTenant(businessUnitId, async (tx) => {
      await tx
        .update(packagePaymentMappings)
        .set({ status: 'failed', lastError: message, updatedAt: new Date() })
        .where(eq(packagePaymentMappings.packageId, packageId));
      await tx
        .update(catalogSyncJobs)
        .set({
          status: 'failed',
          lastError: message,
          nextAttemptAt: new Date(Date.now() + 5 * 60_000),
          updatedAt: new Date(),
        })
        .where(eq(catalogSyncJobs.packageId, packageId));
    });
    return { status: 'failed', error: message };
  }
}

export async function processCatalogSyncJobs(): Promise<void> {
  if (!stripeEnabled()) return;
  const jobs = await withPlatformScope((tx) =>
    tx
      .select({
        businessUnitId: catalogSyncJobs.businessUnitId,
        packageId: catalogSyncJobs.packageId,
      })
      .from(catalogSyncJobs)
      .where(
        and(
          or(eq(catalogSyncJobs.status, 'pending'), eq(catalogSyncJobs.status, 'failed')),
          lte(catalogSyncJobs.nextAttemptAt, new Date()),
        ),
      )
      .limit(10),
  );
  for (const job of jobs) {
    await syncPackageCatalog(job.businessUnitId, job.packageId);
  }
}

export async function createCheckoutSession(input: {
  businessUnitId: string;
  businessUnitSlug: string;
  orderId: string;
  packageId: string;
  amountCents: number;
  customerEmail: string;
}): Promise<{ url: string; sessionId: string }> {
  if (!stripeEnabled()) throw badRequest('Stripe checkout is not enabled');
  const loaded = await withTenant(input.businessUnitId, async (tx) => {
    const [account] = await tx
      .select()
      .from(paymentAccounts)
      .where(eq(paymentAccounts.provider, 'stripe'))
      .limit(1);
    const [mapping] = await tx
      .select()
      .from(packagePaymentMappings)
      .where(
        and(
          eq(packagePaymentMappings.packageId, input.packageId),
          eq(packagePaymentMappings.provider, 'stripe'),
        ),
      )
      .limit(1);
    const [existingPayment] = await tx
      .select({
        status: payments.status,
        checkoutAttempt: payments.checkoutAttempt,
      })
      .from(payments)
      .where(and(eq(payments.orderId, input.orderId), eq(payments.provider, 'stripe')))
      .limit(1);
    return { account, mapping, existingPayment };
  });
  if (!loaded.account?.providerAccountId || !loaded.account.chargesEnabled) {
    throw conflict('This storefront is not ready to accept payments');
  }
  if (!loaded.mapping?.providerPriceId || loaded.mapping.status !== 'synced') {
    throw conflict('This package is not synchronized with Stripe');
  }

  const fee = Math.floor((input.amountCents * env.STRIPE_PLATFORM_FEE_BPS) / 10_000);
  const retryable = ['failed', 'expired', 'cancelled'].includes(
    loaded.existingPayment?.status ?? '',
  );
  const checkoutAttempt = loaded.existingPayment
    ? loaded.existingPayment.checkoutAttempt + (retryable ? 1 : 0)
    : 1;
  const session = await stripeClient().checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [{ price: loaded.mapping.providerPriceId, quantity: 1 }],
      customer_email: input.customerEmail,
      client_reference_id: input.orderId,
      metadata: { qinio_order_id: input.orderId },
      payment_intent_data: {
        metadata: { qinio_order_id: input.orderId },
        ...(fee > 0 ? { application_fee_amount: fee } : {}),
      },
      success_url:
        `${env.WEB_ORIGIN}/checkout/return?order=${encodeURIComponent(input.orderId)}` +
        `&slug=${encodeURIComponent(input.businessUnitSlug)}`,
      cancel_url:
        `${env.WEB_ORIGIN}/checkout/return?order=${encodeURIComponent(input.orderId)}` +
        `&slug=${encodeURIComponent(input.businessUnitSlug)}&cancelled=1`,
    },
    {
      stripeAccount: loaded.account.providerAccountId,
      idempotencyKey: `qinio-checkout-${input.orderId}-${checkoutAttempt}`,
    },
  );
  if (!session.url) throw badRequest('Stripe did not return a checkout URL');

  await withTenant(input.businessUnitId, async (tx) => {
    await tx
      .insert(payments)
      .values({
        businessUnitId: input.businessUnitId,
        orderId: input.orderId,
        provider: 'stripe',
        providerAccountId: loaded.account!.providerAccountId,
        checkoutSessionId: session.id,
        checkoutAttempt,
        status: 'pending',
        amountCents: input.amountCents,
        currency: env.STRIPE_CURRENCY,
      })
      .onConflictDoUpdate({
        target: [payments.orderId, payments.provider],
        set: {
          checkoutSessionId: session.id,
          checkoutAttempt,
          status: 'pending',
          failureCode: null,
          failureMessage: null,
          updatedAt: new Date(),
        },
      });
    await tx
      .update(orders)
      .set({ paymentStatus: 'pending', paymentReference: session.id, updatedAt: new Date() })
      .where(eq(orders.id, input.orderId));
  });
  return { url: session.url, sessionId: session.id };
}

export async function findPaymentAccountByProviderId(accountId: string) {
  return withPlatformScope(async (tx) => {
    const [account] = await tx
      .select()
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.provider, 'stripe'),
          eq(paymentAccounts.providerAccountId, accountId),
        ),
      )
      .limit(1);
    return account;
  });
}

export async function createStripeRefund(input: {
  providerAccountId: string;
  paymentIntentId: string;
  paymentId: string;
  amountCents?: number;
  refundedCents: number;
}) {
  return stripeClient().refunds.create(
    {
      payment_intent: input.paymentIntentId,
      ...(input.amountCents ? { amount: input.amountCents } : {}),
      refund_application_fee: env.STRIPE_PLATFORM_FEE_BPS > 0,
      metadata: { qinio_payment_id: input.paymentId },
    },
    {
      stripeAccount: input.providerAccountId,
      idempotencyKey:
        `qinio-refund-${input.paymentId}-${input.refundedCents}-` +
        `${input.amountCents ?? 'full'}`,
    },
  );
}
