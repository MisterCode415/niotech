import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  type BusinessUnitBrand,
  createCheckoutIntentSchema,
  createGuestOrderSchema,
  registerPatientSchema,
  workspacePath,
} from '@nio/shared';
import { findPublicBusinessUnit } from '../auth/context.js';
import { sendOrderActivationInvites } from '../services/activation.js';
import { createCheckoutIntent, resolveCheckoutIntent } from '../services/checkoutIntents.js';
import { dispatchNotifications } from '../services/notifications.js';
import { dispatchPaidOrder } from '../services/paidOrder.js';
import { paymentProvider } from '../services/payments.js';
import { ensurePatient } from '../services/patients.js';
import { placeOrder } from '../services/placeOrder.js';
import { createCheckoutSession, stripeEnabled } from '../services/stripe.js';
import { withTenant } from '../db/client.js';
import { env } from '../env.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { requestOrigin, tenantOrigin } from '../lib/hostTenant.js';
import { sanitizeMarketingHtml } from '../lib/sanitizeHtml.js';
import { marketingPages, packageTestTypes, packages, testTypes } from '../db/schema.js';

const slugParam = z.object({ slug: z.string() });

/** What every anonymous page may know about a tenant: its name and how it presents itself. */
function publicBusinessUnit(businessUnit: { name: string; slug: string; brand: unknown }) {
  return {
    name: businessUnit.name,
    slug: businessUnit.slug,
    brand: (businessUnit.brand as BusinessUnitBrand | null) ?? null,
  };
}

export async function publicRoutes(app: FastifyInstance) {
  /**
   * Which tenant, if any, the current hostname belongs to. The SPA calls this once at startup:
   * on a custom domain it learns which business unit to serve at `/`, and what brand to wear.
   * On the shared platform host it answers `{ custom: false }`.
   */
  app.get('/api/public/host', async (request) => {
    const host = request.hostTenant;
    if (host.kind !== 'tenant') return { custom: false as const };
    return {
      custom: true as const,
      hostname: host.hostname,
      slug: host.slug,
      name: host.name,
      brand: host.brand,
    };
  });

  /**
   * Login hand-off. Auth0 needs the organization at the moment it redirects, before anyone is
   * authenticated, so the mapping from a public slug to its organization has to be readable
   * anonymously. Organization ids are not secret — they travel as a query parameter on the hosted
   * login URL — and this exposes nothing that the storefront does not already publish.
   */
  app.get('/api/public/:slug/login', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const businessUnit = await findPublicBusinessUnit(slug);
    return {
      businessUnit: publicBusinessUnit(businessUnit),
      organization: businessUnit.auth0OrgId ?? null,
    };
  });

  app.get('/api/public/:slug/page', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const businessUnit = await findPublicBusinessUnit(slug);

    const [page] = await withTenant(businessUnit.id, (tx) =>
      tx
        .select()
        .from(marketingPages)
        .where(eq(marketingPages.isPublished, true))
        .orderBy(desc(marketingPages.version))
        .limit(1),
    );

    return {
      businessUnit: publicBusinessUnit(businessUnit),
      page: page ? { ...page, bodyHtml: sanitizeMarketingHtml(page.bodyHtml) } : null,
    };
  });

  app.get('/api/public/:slug/packages', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const businessUnit = await findPublicBusinessUnit(slug);

    return withTenant(businessUnit.id, async (tx) => {
      const rows = await tx
        .select()
        .from(packages)
        .where(eq(packages.status, 'active'))
        .orderBy(packages.priceCents);

      const tests = await tx
        .select({
          packageId: packageTestTypes.packageId,
          quantity: packageTestTypes.quantity,
          name: testTypes.name,
          description: testTypes.description,
          sampleType: testTypes.sampleType,
          turnaroundDays: testTypes.turnaroundDays,
        })
        .from(packageTestTypes)
        .innerJoin(testTypes, eq(testTypes.id, packageTestTypes.testTypeId));

      return {
        businessUnit: publicBusinessUnit(businessUnit),
        packages: rows.map((pkg) => ({
          ...pkg,
          tests: tests.filter((t) => t.packageId === pkg.id),
          kitCount: tests
            .filter((t) => t.packageId === pkg.id)
            .reduce((sum, t) => sum + t.quantity, 0),
        })),
      };
    });
  });

  /**
   * Marketing-site handoff. The caller names a package and, optionally, a return link on one of
   * the business unit's registered origins; the response is the Qinio URL to send the shopper to.
   * Nothing the caller supplies is trusted for pricing, and nothing about the shopper is stored.
   */
  app.post(
    '/api/public/:slug/checkout-intents',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { slug } = slugParam.parse(request.params);
      const businessUnit = await findPublicBusinessUnit(slug);
      const input = createCheckoutIntentSchema.parse(request.body);

      const intent = await createCheckoutIntent(businessUnit, input);
      // A white-labelled tenant's shoppers land on its own domain, never the platform host.
      const origin = await tenantOrigin(businessUnit.id);
      const url =
        `${origin}/${encodeURIComponent(slug)}/buy/${intent.packageId}` + `?intent=${intent.id}`;
      return reply.status(201).send({ id: intent.id, url, expiresAt: intent.expiresAt });
    },
  );

  app.get(
    '/api/public/:slug/checkout-intents/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const { slug, id } = z.object({ slug: z.string(), id: z.uuid() }).parse(request.params);
      const businessUnit = await findPublicBusinessUnit(slug);
      const intent = await resolveCheckoutIntent(businessUnit, id);
      return {
        businessUnit: publicBusinessUnit(businessUnit),
        intent,
      };
    },
  );

  /**
   * Pay-first guest checkout. The shopper needs no account and no login: they give an email,
   * name, and shipping address, and go straight to payment. Only the roster entry is reserved
   * here. The identity-provider account and activation email are created after payment clears
   * (see services/activation.ts), so an abandoned checkout provisions nothing, and results stay
   * locked until the owner of the address activates the account.
   *
   * The response never says whether the email already had an account.
   */
  app.post(
    '/api/public/:slug/orders',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const { slug } = slugParam.parse(request.params);
      const businessUnit = await findPublicBusinessUnit(slug);
      const input = createGuestOrderSchema.parse(request.body);

      const useStripe = stripeEnabled();
      if (!useStripe && env.NODE_ENV === 'production') {
        // The mock processor "pays" instantly, which an anonymous endpoint must never offer.
        throw new HttpError(503, 'Checkout is not available right now');
      }

      const [available] = await withTenant(businessUnit.id, (tx) =>
        tx
          .select({ id: packages.id })
          .from(packages)
          .where(and(eq(packages.id, input.packageId), eq(packages.status, 'active')))
          .limit(1),
      );
      if (!available) throw notFound('Package not available');

      const patient = await ensurePatient({
        businessUnit,
        email: input.email,
        name: input.name,
        invite: 'deferred',
        rename: false,
      });

      const order = await withTenant(businessUnit.id, (tx) =>
        placeOrder(tx, {
          businessUnitId: businessUnit.id,
          patientUserId: patient.id,
          actorRole: 'system',
          actorUserId: null,
          packageId: input.packageId,
          shippingAddress: input.shippingAddress,
          shippingMethod: input.shippingMethod,
          attribution: input.attribution,
          intentId: input.intentId,
          guestActivation: true,
        }),
      );

      if (useStripe) {
        const session = await createCheckoutSession({
          businessUnitId: businessUnit.id,
          businessUnitSlug: slug,
          orderId: order.id,
          packageId: order.packageId,
          amountCents: order.priceCents,
          customerEmail: input.email,
          guest: true,
          origin: requestOrigin(request, businessUnit.id),
        });
        return reply.status(201).send({ checkoutUrl: session.url });
      }

      // Development and tests: the mock processor captures immediately.
      const intents = await withTenant(businessUnit.id, async (tx) => {
        const charge = await paymentProvider.charge({
          orderId: order.id,
          orderNumber: order.orderNumber,
          amountCents: order.priceCents,
          paymentToken: 'mock-token',
        });
        if (charge.status !== 'paid') throw badRequest('Payment was declined');
        return dispatchPaidOrder(tx, {
          businessUnitId: businessUnit.id,
          order,
          paymentReference: charge.reference,
          actorRole: 'system',
          actorUserId: null,
        });
      });
      await dispatchNotifications(intents);
      await sendOrderActivationInvites([order.id]);
      return reply.status(201).send({ paid: true });
    },
  );

  /**
   * Patient self-registration. A patient is a member of one business unit's roster like any other
   * role, which is what keeps their orders and results inside that tenant.
   */
  app.post(
    '/api/public/:slug/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const { slug } = slugParam.parse(request.params);
      const businessUnit = await findPublicBusinessUnit(slug);
      const input = registerPatientSchema.parse(request.body);

      const packageId = input.packageId;
      if (packageId) {
        const [available] = await withTenant(businessUnit.id, (tx) =>
          tx
            .select({ id: packages.id })
            .from(packages)
            .where(and(eq(packages.id, packageId), eq(packages.status, 'active')))
            .limit(1),
        );
        if (!available) throw conflict('Package is not available');
      }

      const returnTo = input.packageId
        ? `/${slug}/checkout/${input.packageId}`
        : workspacePath(slug, 'patient');

      // Always the same generic response: the caller learns nothing about existing accounts.
      await ensurePatient({
        businessUnit,
        email: input.email,
        name: input.name,
        returnTo,
        invite: 'now',
        origin: requestOrigin(request, businessUnit.id),
      });

      return reply.status(202).send({ accepted: true });
    },
  );
}
