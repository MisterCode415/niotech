import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { findPublicBusinessUnit } from '../auth/context.js';
import { devAuthProvider } from '../auth/index.js';
import { closeDb, withPlatformScope, withTenant } from '../db/client.js';
import { kits, memberships, orders, paymentAccounts, payments, users } from '../db/schema.js';
import { sendOrderActivationInvites } from '../services/activation.js';
import { ensurePatient } from '../services/patients.js';
import { placeOrder } from '../services/placeOrder.js';
import { stripeClient } from '../services/stripe.js';
import { TEST_ADDRESS } from './harness.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function uniqueEmail(label: string) {
  return `guest-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@guest.test`;
}

async function activePackage() {
  const response = await app.inject({ method: 'GET', url: '/api/public/vitality/packages' });
  const catalog = response.json() as { packages: Array<{ id: string; kitCount: number }> };
  return catalog.packages[0]!;
}

function guestOrder(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/public/vitality/orders', payload });
}

async function userByEmail(email: string) {
  const [row] = await withPlatformScope((tx) =>
    tx.select().from(users).where(eq(users.email, email)).limit(1),
  );
  return row;
}

/** An order exactly as the guest endpoint leaves it before a processor confirms payment. */
async function placePendingGuestOrder(email: string, name = 'Pending Guest') {
  const businessUnit = await findPublicBusinessUnit('vitality');
  const pkg = await activePackage();
  const patient = await ensurePatient({
    businessUnit,
    email,
    name,
    invite: 'deferred',
    rename: false,
  });
  const order = await withTenant(businessUnit.id, (tx) =>
    placeOrder(tx, {
      businessUnitId: businessUnit.id,
      patientUserId: patient.id,
      actorRole: 'system',
      actorUserId: null,
      packageId: pkg.id,
      shippingAddress: TEST_ADDRESS,
      shippingMethod: 'ground',
      guestActivation: true,
    }),
  );
  return { businessUnit, order, patient, pkg };
}

describe('guest checkout', () => {
  it('takes a shopper with no account from order to paid, then activates the account', async () => {
    const inviteUser = vi.spyOn(devAuthProvider()!, 'inviteUser');
    const pkg = await activePackage();
    const email = uniqueEmail('new');

    const response = await guestOrder({
      packageId: pkg.id,
      email,
      name: 'New Guest',
      shippingAddress: TEST_ADDRESS,
      shippingMethod: 'ground',
      attribution: { utm_source: 'newsletter', unknown: 'dropped' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ paid: true });

    const user = await userByEmail(email);
    expect(user).toBeDefined();
    // Bound to an identity only because payment cleared and the invite was sent.
    expect(user!.auth0UserId).toBe(`dev|${email}`);
    expect(inviteUser).toHaveBeenCalledTimes(1);

    const [order] = await withPlatformScope((tx) =>
      tx.select().from(orders).where(eq(orders.patientUserId, user!.id)),
    );
    expect(order).toMatchObject({
      status: 'dispatched_to_fulfillment',
      paymentStatus: 'paid',
      guestActivation: true,
      attribution: { utm_source: 'newsletter' },
    });
    expect(order!.activationInviteSentAt).not.toBeNull();

    const [member] = await withPlatformScope((tx) =>
      tx.select().from(memberships).where(eq(memberships.userId, user!.id)),
    );
    expect(member).toMatchObject({ role: 'patient', status: 'active' });
  });

  it('gives the same response for an existing account and leaves it untouched', async () => {
    const pkg = await activePackage();
    const before = await userByEmail('patient@vitality.test');

    const response = await guestOrder({
      packageId: pkg.id,
      email: 'patient@vitality.test',
      name: 'Someone Else Entirely',
      shippingAddress: TEST_ADDRESS,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ paid: true });

    const after = await userByEmail('patient@vitality.test');
    expect(after!.name).toBe(before!.name);
    expect(after!.id).toBe(before!.id);

    const attached = await withPlatformScope((tx) =>
      tx
        .select({ id: orders.id, guestActivation: orders.guestActivation })
        .from(orders)
        .where(eq(orders.patientUserId, before!.id)),
    );
    expect(attached.some((row) => row.guestActivation)).toBe(true);
  });

  it('rejects invalid input and unavailable packages', async () => {
    const pkg = await activePackage();
    const bad = await guestOrder({
      packageId: pkg.id,
      email: 'not-an-email',
      name: 'X',
      shippingAddress: TEST_ADDRESS,
    });
    expect(bad.statusCode).toBe(400);

    const noPackageEmail = uniqueEmail('nopkg');
    const unknown = await guestOrder({
      packageId: '00000000-0000-4000-8000-000000000000',
      email: noPackageEmail,
      name: 'No Package',
      shippingAddress: TEST_ADDRESS,
    });
    expect(unknown.statusCode).toBe(404);
    // Nothing is reserved for a request that could not become an order.
    expect(await userByEmail(noPackageEmail)).toBeUndefined();
  });

  it('refuses a suspended account with a generic message', async () => {
    const email = uniqueEmail('suspended');
    const businessUnit = await findPublicBusinessUnit('vitality');
    await ensurePatient({ businessUnit, email, name: 'Suspended', invite: 'deferred' });
    await withPlatformScope((tx) =>
      tx.update(users).set({ status: 'suspended' }).where(eq(users.email, email)),
    );

    const response = await guestOrder({
      packageId: (await activePackage()).id,
      email,
      name: 'Suspended',
      shippingAddress: TEST_ADDRESS,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Checkout is not available for this email');
  });

  it('does not offer the order to the anonymous caller as a signed-in resource', async () => {
    const { order } = await placePendingGuestOrder(uniqueEmail('locked'));
    const response = await app.inject({
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${order.id}`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('identity adoption', () => {
  it('lets registration claim a row reserved by an earlier guest checkout', async () => {
    const email = uniqueEmail('adopt');
    await placePendingGuestOrder(email, 'Reserved Name');
    expect((await userByEmail(email))!.auth0UserId).toBeNull();

    const response = await app.inject({
      method: 'POST',
      url: '/api/public/vitality/register',
      payload: { email, name: 'Registered Name' },
    });
    expect(response.statusCode).toBe(202);

    const user = await userByEmail(email);
    expect(user!.auth0UserId).toBe(`dev|${email}`);
  });
});

describe('deferred activation', () => {
  it('provisions nothing for an order that has not been paid', async () => {
    const inviteUser = vi.spyOn(devAuthProvider()!, 'inviteUser');
    const email = uniqueEmail('unpaid');
    const { order } = await placePendingGuestOrder(email);

    await sendOrderActivationInvites([order.id]);

    expect(inviteUser).not.toHaveBeenCalled();
    const user = await userByEmail(email);
    expect(user!.auth0UserId).toBeNull();
    const [saved] = await withPlatformScope((tx) =>
      tx.select().from(orders).where(eq(orders.id, order.id)),
    );
    expect(saved!.activationInviteSentAt).toBeNull();
  });

  it('sends the invite once when Stripe confirms payment, even if the event is replayed', async () => {
    const inviteUser = vi.spyOn(devAuthProvider()!, 'inviteUser');
    const email = uniqueEmail('stripe');
    const { businessUnit, order, pkg } = await placePendingGuestOrder(email);

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sessionId = `cs_test_guest_${suffix}`;
    const eventId = `evt_test_guest_${suffix}`;
    const accountId = 'acct_test_qinio_vitality';

    await withPlatformScope(async (tx) => {
      await tx
        .insert(paymentAccounts)
        .values({
          businessUnitId: businessUnit.id,
          provider: 'stripe',
          providerAccountId: accountId,
          status: 'active',
          chargesEnabled: true,
          payoutsEnabled: true,
          detailsSubmitted: true,
        })
        .onConflictDoUpdate({
          target: [paymentAccounts.businessUnitId, paymentAccounts.provider],
          set: {
            providerAccountId: accountId,
            status: 'active',
            chargesEnabled: true,
            payoutsEnabled: true,
          },
        });
      await tx.insert(payments).values({
        businessUnitId: businessUnit.id,
        orderId: order.id,
        provider: 'stripe',
        providerAccountId: accountId,
        checkoutSessionId: sessionId,
        status: 'pending',
        amountCents: order.priceCents,
        currency: 'usd',
      });
      await tx
        .update(orders)
        .set({ paymentStatus: 'pending', paymentReference: sessionId })
        .where(eq(orders.id, order.id));
    });

    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      account: accountId,
      api_version: '2025-12-15.clover',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: sessionId,
          object: 'checkout.session',
          payment_intent: `pi_test_${suffix}`,
          payment_status: 'paid',
          status: 'complete',
          amount_total: order.priceCents,
          currency: 'usd',
        },
      },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: 'checkout.session.completed',
    });
    const signature = stripeClient().webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_qinio_unit_tests_only',
    });

    // Before the event arrives the shopper has no identity at all.
    expect((await userByEmail(email))!.auth0UserId).toBeNull();

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        payload,
      });
      expect(response.statusCode).toBe(200);
    }

    expect(inviteUser).toHaveBeenCalledTimes(1);
    expect(inviteUser.mock.calls[0]![0]).toMatchObject({
      email,
      loginPath: expect.stringContaining(encodeURIComponent(`/orders/${order.id}`)),
    });
    expect((await userByEmail(email))!.auth0UserId).toBe(`dev|${email}`);

    const [saved] = await withPlatformScope((tx) =>
      tx.select().from(orders).where(eq(orders.id, order.id)),
    );
    expect(saved).toMatchObject({ paymentStatus: 'paid', status: 'dispatched_to_fulfillment' });
    expect(saved!.activationInviteSentAt).not.toBeNull();

    const kitRows = await withPlatformScope((tx) =>
      tx.select({ id: kits.id }).from(kits).where(eq(kits.orderId, order.id)),
    );
    expect(kitRows).toHaveLength(pkg.kitCount);

    // A direct retry is a no-op: the claim was already taken.
    await sendOrderActivationInvites([order.id]);
    expect(inviteUser).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when delivery fails so the sweep can retry', async () => {
    const email = uniqueEmail('retry');
    const { order } = await placePendingGuestOrder(email);
    await withPlatformScope((tx) =>
      tx.update(orders).set({ paymentStatus: 'paid' }).where(eq(orders.id, order.id)),
    );

    const inviteUser = vi
      .spyOn(devAuthProvider()!, 'inviteUser')
      .mockRejectedValueOnce(new Error('identity provider unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendOrderActivationInvites([order.id]);
    let [saved] = await withPlatformScope((tx) =>
      tx.select().from(orders).where(eq(orders.id, order.id)),
    );
    expect(saved!.activationInviteSentAt).toBeNull();

    await sendOrderActivationInvites([order.id]);
    [saved] = await withPlatformScope((tx) =>
      tx.select().from(orders).where(eq(orders.id, order.id)),
    );
    expect(saved!.activationInviteSentAt).not.toBeNull();
    expect(inviteUser).toHaveBeenCalledTimes(2);
  });
});