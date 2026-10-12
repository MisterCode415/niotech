import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { closeDb, withPlatformScope, withTenant } from '../db/client.js';
import { requireOrganizationScope, type Actor, type ActorMembership } from '../auth/context.js';
import { devAuthProvider } from '../auth/index.js';
import {
  businessUnits,
  kits,
  notifications,
  orders,
  paymentAccounts,
  paymentEvents,
  payments,
  phiAccessEvents,
  users,
} from '../db/schema.js';
import { call, login, auth, multipartBody, SAMPLE_PDF, TEST_ADDRESS } from './harness.js';
import { stripeClient } from '../services/stripe.js';

interface PackageSummary {
  id: string;
  name: string;
  requiresClinician: boolean;
  kitCount: number;
}

interface OrderDetail {
  order: { id: string; orderNumber: string; status: string; requiresClinician: boolean };
  kits: Array<{ id: string; kitNumber: number; status: string; qrToken: string }>;
  events: Array<{ toStatus: string | null; message: string; actorRole: string }>;
  results: Array<{ fileId: string | null }>;
  review: { decision: string | null; interpretation: string | null; aiDraft: string | null } | null;
}

let app: FastifyInstance;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  for (const [key, email] of Object.entries({
    patient: 'patient@vitality.test',
    fulfillment: 'fulfillment@vitality.test',
    lab: 'lab@vitality.test',
    doctor: 'doctor@vitality.test',
    admin: 'admin@vitality.test',
    otherPatient: 'patient@metabolic.test',
    metabolicAdmin: 'admin@metabolic.test',
    platform: 'admin@niotech.test',
  })) {
    tokens[key] = await login(app, email);
  }
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

async function findPackage(requiresClinician: boolean): Promise<PackageSummary> {
  const body = await app
    .inject({ method: 'GET', url: '/api/public/vitality/packages' })
    .then((r) => r.json() as { packages: PackageSummary[] });
  const pkg = body.packages.find((p) => p.requiresClinician === requiresClinician);
  if (!pkg) throw new Error(`No package found with requiresClinician=${requiresClinician}`);
  return pkg;
}

/** Places an order and walks it as far as the lab bench, which both branches share. */
async function driveToLabBench(pkg: PackageSummary) {
  const { order } = await call<{ order: { id: string } }>(app, {
    method: 'POST',
    url: '/api/bu/vitality/patient/orders',
    token: tokens.patient!,
    payload: {
      packageId: pkg.id,
      shippingAddress: TEST_ADDRESS,
      shippingMethod: 'two_day',
    },
    expect: 201,
  });
  const orderId = order.id;

  await call(app, {
    method: 'POST',
    url: `/api/bu/vitality/patient/orders/${orderId}/pay`,
    token: tokens.patient!,
    payload: { paymentToken: 'tok_test' },
  });

  await call(app, {
    method: 'POST',
    url: `/api/bu/vitality/fulfillment/orders/${orderId}/correlate`,
    token: tokens.fulfillment!,
    payload: { externalOrderId: `FUL-${Date.now()}` },
  });

  await call(app, {
    method: 'POST',
    url: `/api/bu/vitality/fulfillment/orders/${orderId}/label`,
    token: tokens.fulfillment!,
  });

  await call(app, {
    method: 'POST',
    url: `/api/bu/vitality/fulfillment/orders/${orderId}/ship`,
    token: tokens.fulfillment!,
    payload: { carrier: 'UPS', trackingNumber: `1Z${Date.now()}` },
  });

  const shipped = await call<OrderDetail>(app, {
    method: 'GET',
    url: `/api/bu/vitality/patient/orders/${orderId}`,
    token: tokens.patient!,
  });
  expect(shipped.order.status).toBe('kit_shipped');
  expect(shipped.kits).toHaveLength(pkg.kitCount);

  for (const kit of shipped.kits) {
    await call(app, {
      method: 'POST',
      url: `/api/bu/vitality/patient/orders/${orderId}/kits/${kit.id}/received`,
      token: tokens.patient!,
    });
  }
  for (const kit of shipped.kits) {
    await call(app, {
      method: 'POST',
      url: `/api/bu/vitality/patient/orders/${orderId}/kits/${kit.id}/sent-to-lab`,
      token: tokens.patient!,
    });
  }
  for (const kit of shipped.kits) {
    await call(app, {
      method: 'POST',
      url: `/api/bu/vitality/lab/kits/${kit.id}/check-in`,
      token: tokens.lab!,
    });
  }

  return { orderId, kits: shipped.kits };
}

async function uploadResults(orderId: string): Promise<string> {
  const { payload, headers } = multipartBody('file', 'results.pdf', 'application/pdf', SAMPLE_PDF);
  const response = await app.inject({
    method: 'POST',
    url: `/api/bu/vitality/lab/orders/${orderId}/files`,
    headers: { ...auth(tokens.lab!), ...headers },
    payload,
  });
  if (response.statusCode !== 201) {
    throw new Error(`Upload failed: ${response.statusCode} ${response.body}`);
  }
  return response.json().file.id as string;
}

describe('order workflow: clinician branch', () => {
  it('moves an order from purchase to a doctor-reviewed release, recording every step', async () => {
    const pkg = await findPackage(true);
    const { orderId, kits } = await driveToLabBench(pkg);

    const fileId = await uploadResults(orderId);

    let routedTo: string | null = null;
    for (const kit of kits) {
      const result = await call<{ routedTo: string | null }>(app, {
        method: 'POST',
        url: `/api/bu/vitality/lab/kits/${kit.id}/complete`,
        token: tokens.lab!,
        payload: { fileId, summary: 'All markers captured.' },
      });
      routedTo = result.routedTo ?? routedTo;
    }

    expect(routedTo).toBe('doctor');
    const doctorNotes = await withPlatformScope((tx) =>
      tx.select({ type: notifications.type }).from(notifications).where(eq(notifications.orderId, orderId)),
    );
    expect(doctorNotes.map((row) => row.type)).toContain('review_requested');
    expect(doctorNotes.map((row) => row.type)).not.toContain('results_released');

    const queue = await call<{ pending: Array<{ orderId: string }> }>(app, {
      method: 'GET',
      url: '/api/bu/vitality/doctor/queue',
      token: tokens.doctor!,
    });
    expect(queue.pending.map((p) => p.orderId)).toContain(orderId);

    // The patient must not see results while they are still with the doctor.
    const beforeRelease = await call<OrderDetail>(app, {
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${orderId}`,
      token: tokens.patient!,
    });
    expect(beforeRelease.order.status).toBe('awaiting_clinician_review');
    expect(beforeRelease.results).toHaveLength(0);
    expect(beforeRelease.review).toBeNull();

    const review = await call<OrderDetail>(app, {
      method: 'GET',
      url: `/api/bu/vitality/doctor/reviews/${orderId}`,
      token: tokens.doctor!,
    });
    expect(review.review?.aiDraft).toContain('DRAFT');

    await call(app, {
      method: 'POST',
      url: `/api/bu/vitality/doctor/reviews/${orderId}`,
      token: tokens.doctor!,
      payload: {
        decision: 'approved',
        interpretation: 'Markers are within range for the metabolic program.',
        recommendations: 'Re-test in 90 days.',
      },
    });

    const released = await call<OrderDetail>(app, {
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${orderId}`,
      token: tokens.patient!,
    });

    expect(released.order.status).toBe('results_released');
    expect(released.review?.decision).toBe('approved');
    expect(released.results.length).toBeGreaterThan(0);

    const trail = released.events.map((e) => e.toStatus).filter(Boolean);
    expect(trail).toEqual([
      'pending_payment',
      'paid',
      'dispatched_to_fulfillment',
      'kit_shipped',
      'kit_received_by_patient',
      'sample_in_transit',
      'received_by_lab',
      'lab_processing',
      'lab_complete',
      'awaiting_clinician_review',
      'clinician_approved',
      'results_released',
    ]);

    const fileIdOnOrder = released.results[0]?.fileId;
    expect(fileIdOnOrder).toBeTruthy();
    const download = await app.inject({
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${orderId}/results/${fileIdOnOrder}`,
      headers: auth(tokens.patient!),
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    // The model's draft is the clinician's working note; the patient's copy never carries it.
    expect(released.review).not.toBeNull();
    expect(Object.keys(released.review!)).not.toContain('aiDraft');
    expect(Object.keys(released.review!)).not.toContain('aiModel');

    // Every PHI read above left a row: the doctor's review, the patient's view, and the PDF.
    const trailRows = await withPlatformScope((tx) =>
      tx
        .select({
          actorRole: phiAccessEvents.actorRole,
          resourceType: phiAccessEvents.resourceType,
          action: phiAccessEvents.action,
        })
        .from(phiAccessEvents)
        .where(eq(phiAccessEvents.orderId, orderId)),
    );
    const seen = trailRows.map((row) => `${row.actorRole}:${row.resourceType}:${row.action}`);
    expect(seen).toContain('doctor:review:view');
    expect(seen).toContain('patient:order_detail:view');
    expect(seen).toContain('patient:result_file:download');
    // The pre-release patient view exposed nothing clinical, so it is not an access.
    expect(seen.filter((entry) => entry === 'patient:order_detail:view')).toHaveLength(1);
  });
});

describe('order workflow: direct-to-patient branch', () => {
  it('skips the doctor queue when the package needs no clinician', async () => {
    const pkg = await findPackage(false);
    const { orderId, kits } = await driveToLabBench(pkg);

    const fileId = await uploadResults(orderId);

    let routedTo: string | null = null;
    for (const kit of kits) {
      const result = await call<{ routedTo: string | null }>(app, {
        method: 'POST',
        url: `/api/bu/vitality/lab/kits/${kit.id}/complete`,
        token: tokens.lab!,
        payload: { fileId },
      });
      routedTo = result.routedTo ?? routedTo;
    }

    expect(routedTo).toBe('patient');
    const patientNotes = await withPlatformScope((tx) =>
      tx.select({ type: notifications.type }).from(notifications).where(eq(notifications.orderId, orderId)),
    );
    expect(patientNotes.map((row) => row.type)).toContain('results_released');
    expect(patientNotes.map((row) => row.type)).not.toContain('review_requested');

    const released = await call<OrderDetail>(app, {
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${orderId}`,
      token: tokens.patient!,
    });

    expect(released.order.status).toBe('results_released');
    expect(released.review).toBeNull();
    expect(released.results.length).toBeGreaterThan(0);

    const trail = released.events.map((e) => e.toStatus).filter(Boolean);
    expect(trail).not.toContain('awaiting_clinician_review');
    expect(trail.at(-1)).toBe('results_released');

    // A doctor cannot open a review for a package that never involved one.
    const doctorAttempt = await app.inject({
      method: 'GET',
      url: `/api/bu/vitality/doctor/reviews/${orderId}`,
      headers: auth(tokens.doctor!),
    });
    expect(doctorAttempt.statusCode).toBe(400);
  });
});

describe('tenant isolation', () => {
  it('hides another business unit orders, kits and portals', async () => {
    const pkg = await findPackage(false);
    const { order } = await call<{ order: { id: string; priceCents: number } }>(app, {
      method: 'POST',
      url: '/api/bu/vitality/patient/orders',
      token: tokens.patient!,
      payload: { packageId: pkg.id, shippingAddress: TEST_ADDRESS, shippingMethod: 'ground' },
      expect: 201,
    });

    // A patient from another tenant has no membership in `vitality`, so the route denies them
    // before any row is read.
    const crossTenantRead = await app.inject({
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${order.id}`,
      headers: auth(tokens.otherPatient!),
    });
    expect(crossTenantRead.statusCode).toBe(404);

    // Same order id, requested through the tenant the caller does belong to: still not found,
    // because row-level security scopes the lookup to that tenant.
    const wrongTenantPath = await app.inject({
      method: 'GET',
      url: `/api/bu/metabolic/patient/orders/${order.id}`,
      headers: auth(tokens.otherPatient!),
    });
    expect(wrongTenantPath.statusCode).toBe(404);

    // Holding a role in the tenant is not enough; it has to be the right role.
    const wrongRole = await app.inject({
      method: 'GET',
      url: '/api/bu/vitality/doctor/queue',
      headers: auth(tokens.lab!),
    });
    expect(wrongRole.statusCode).toBe(403);

    // Platform superadmin is not a tenant role and gets no clinical access by default.
    const platformAttempt = await app.inject({
      method: 'GET',
      url: '/api/bu/vitality/patient/orders',
      headers: auth(tokens.platform!),
    });
    expect(platformAttempt.statusCode).toBe(404);
  });

  it('refuses a QR scan from a user outside the kit tenant', async () => {
    const pkg = await findPackage(false);
    const { orderId, kits } = await driveToLabBench(pkg);
    const kit = kits[0]!;

    const foreignScan = await app.inject({
      method: 'GET',
      url: `/api/scan/${kit.qrToken}`,
      headers: auth(tokens.otherPatient!),
    });
    // Indistinguishable from an unknown code, so a typed serial cannot probe other tenants.
    expect(foreignScan.statusCode).toBe(404);

    const labScan = await call<{ role: string; orderPath: string }>(app, {
      method: 'GET',
      url: `/api/scan/${kit.qrToken}`,
      token: tokens.lab!,
    });
    expect(labScan.role).toBe('lab');
    expect(labScan.orderPath).toContain(`?kit=${kit.id}`);

    void orderId;
  });
});

describe('identity and database authorization boundaries', () => {
  it('does not rebind an existing account when a different subject asserts the same email', async () => {
    const dev = devAuthProvider();
    expect(dev).not.toBeNull();
    const impostorToken = await dev!.issueToken({
      provider: 'dev',
      subject: 'dev|different-subject',
      email: 'patient@vitality.test',
      name: 'Impostor',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(impostorToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      userId: null,
      isPlatformAdmin: false,
      memberships: [],
      availableMemberships: [],
    });
  });

  it('requires an Auth0 token organization to match the selected membership', () => {
    const actor = {
      identity: {
        provider: 'auth0',
        subject: 'auth0|person',
        email: 'person@example.test',
        orgId: 'org_other',
      },
    } as Actor;
    const membership = {
      auth0OrgId: 'org_expected',
    } as ActorMembership;

    expect(() => requireOrganizationScope(actor, membership)).toThrow(
      'session is scoped to a different organization',
    );
  });

  it('enforces patient ownership inside one tenant at the RLS layer', async () => {
    const identity = await withPlatformScope(async (tx) => {
      const [businessUnit] = await tx
        .select({ id: businessUnits.id })
        .from(businessUnits)
        .where(eq(businessUnits.slug, 'vitality'))
        .limit(1);
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, 'patient@vitality.test'))
        .limit(1);
      const [foreignPatient] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, 'patient@metabolic.test'))
        .limit(1);
      return {
        businessUnitId: businessUnit!.id,
        ownerId: owner!.id,
        foreignPatientId: foreignPatient!.id,
      };
    });

    const countVisibleOrders = (userId: string, actorRole: 'patient' | 'doctor') =>
      withTenant({ businessUnitId: identity.businessUnitId, userId, actorRole }, async (tx) => {
        const [result] = await tx.select({ count: sql<number>`count(*)::int` }).from(orders);
        return result!.count;
      });

    expect(await countVisibleOrders(identity.ownerId, 'patient')).toBeGreaterThan(0);
    expect(await countVisibleOrders(identity.foreignPatientId, 'patient')).toBe(0);
    expect(await countVisibleOrders(identity.foreignPatientId, 'doctor')).toBeGreaterThan(0);
  });
});

describe('storefront commerce readiness', () => {
  it('does not enumerate tenants and returns an account-neutral registration response', async () => {
    const directory = await app.inject({ method: 'GET', url: '/api/public/business-units' });
    expect(directory.statusCode).toBe(404);

    const response = await app.inject({
      method: 'POST',
      url: '/api/public/vitality/register',
      payload: {
        email: `new-patient-${Date.now()}@example.test`,
        name: 'New Patient',
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });

    const existing = await app.inject({
      method: 'POST',
      url: '/api/public/vitality/register',
      payload: { email: 'patient@vitality.test', name: 'Existing Patient' },
    });
    expect(existing.statusCode).toBe(202);
    expect(existing.json()).toEqual({ accepted: true });
  });

  it('versions a sold package and keeps the order composition snapshot immutable', async () => {
    const testCatalog = await call<{
      testTypes: Array<{ id: string; name: string }>;
    }>(app, {
      method: 'GET',
      url: '/api/bu/vitality/test-types',
      token: tokens.admin!,
    });
    const testType = testCatalog.testTypes[0]!;
    const suffix = Date.now().toString();
    const original = {
      name: `Versioned package ${suffix}`,
      description: 'Original',
      focusArea: 'regression',
      internalReference: `VERSION-${suffix}`,
      externalProductId: `external-v1-${suffix}`,
      externalPurchaseUrl: 'https://store.example.test/original',
      priceCents: 12500,
      requiresClinician: false,
      status: 'active',
      tests: [{ testTypeId: testType.id, quantity: 2 }],
    };
    const created = await call<{ package: { id: string } }>(app, {
      method: 'POST',
      url: '/api/bu/vitality/packages',
      token: tokens.admin!,
      payload: original,
      expect: 201,
    });
    const placed = await call<{ order: { id: string } }>(app, {
      method: 'POST',
      url: '/api/bu/vitality/patient/orders',
      token: tokens.patient!,
      payload: {
        packageId: created.package.id,
        shippingAddress: TEST_ADDRESS,
        shippingMethod: 'ground',
      },
      expect: 201,
    });

    const updated = await call<{
      package: { id: string; version: number };
      versioned: boolean;
    }>(app, {
      method: 'PUT',
      url: `/api/bu/vitality/packages/${created.package.id}`,
      token: tokens.admin!,
      payload: {
        ...original,
        priceCents: 15000,
        externalProductId: `external-v2-${suffix}`,
        externalPurchaseUrl: 'https://store.example.test/current',
        tests: [{ testTypeId: testType.id, quantity: 3 }],
      },
    });
    expect(updated.versioned).toBe(true);
    expect(updated.package.version).toBe(2);
    expect(updated.package.id).not.toBe(created.package.id);

    const snapshot = await withPlatformScope(async (tx) => {
      const [row] = await tx
        .select({
          priceCents: orders.priceCents,
          packageSnapshot: orders.packageSnapshot,
        })
        .from(orders)
        .where(eq(orders.id, placed.order.id))
        .limit(1);
      return row!;
    });
    expect(snapshot.priceCents).toBe(12500);
    expect(snapshot.packageSnapshot.priceCents).toBe(12500);
    expect(snapshot.packageSnapshot.tests[0]?.quantity).toBe(2);

    await call(app, {
      method: 'POST',
      url: `/api/bu/vitality/patient/orders/${placed.order.id}/pay`,
      token: tokens.patient!,
      payload: { paymentToken: 'snapshot_test' },
    });
    const detail = await call<OrderDetail>(app, {
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${placed.order.id}`,
      token: tokens.patient!,
    });
    expect(detail.kits).toHaveLength(2);
  });

  it('reconciles an external purchase exactly once', async () => {
    const testCatalog = await call<{ testTypes: Array<{ id: string }> }>(app, {
      method: 'GET',
      url: '/api/bu/vitality/test-types',
      token: tokens.admin!,
    });
    const suffix = Date.now().toString();
    const packageReference = `partner-product-${suffix}`;
    await call(app, {
      method: 'POST',
      url: '/api/bu/vitality/packages',
      token: tokens.admin!,
      payload: {
        name: `External package ${suffix}`,
        priceCents: 9900,
        requiresClinician: false,
        status: 'active',
        externalProductId: packageReference,
        tests: [{ testTypeId: testCatalog.testTypes[0]!.id, quantity: 1 }],
      },
      expect: 201,
    });
    const payload = {
      source: 'mock_partner',
      externalOrderId: `partner-order-${suffix}`,
      externalPaymentId: `partner-payment-${suffix}`,
      packageReference,
      patient: {
        email: `external-patient-${suffix}@example.test`,
        name: 'External Patient',
      },
      shippingAddress: TEST_ADDRESS,
      shippingMethod: 'two_day',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/integrations/vitality/purchases',
      headers: {
        'x-qinio-integration-key': 'test-integration-secret-at-least-32-characters',
      },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/integrations/vitality/purchases',
      headers: {
        'x-qinio-integration-key': 'test-integration-secret-at-least-32-characters',
      },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      replayed: true,
      order: { id: first.json().order.id },
    });

    const otherCatalog = await call<{ testTypes: Array<{ id: string }> }>(app, {
      method: 'GET',
      url: '/api/bu/metabolic/test-types',
      token: tokens.metabolicAdmin!,
    });
    const sameReferenceOtherTenant = await app.inject({
      method: 'POST',
      url: '/api/bu/metabolic/packages',
      headers: auth(tokens.metabolicAdmin!),
      payload: {
        name: `Other tenant package ${suffix}`,
        priceCents: 8800,
        requiresClinician: false,
        status: 'active',
        externalProductId: packageReference,
        tests: [{ testTypeId: otherCatalog.testTypes[0]!.id, quantity: 1 }],
      },
    });
    expect(sameReferenceOtherTenant.statusCode).toBe(201);
  });

  it('rate-limits repeated public registration attempts', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/public/metabolic/register',
        remoteAddress: '198.51.100.44',
        payload: {
          email: `registration-limit-${attempt}-${Date.now()}@example.test`,
          name: 'Rate Limit Test',
        },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);
  });
});

describe('Stripe webhook boundary', () => {
  it('verifies a connected-account event and dispatches fulfillment exactly once', async () => {
    const pkg = await findPackage(false);
    const { order } = await call<{ order: { id: string; priceCents: number } }>(app, {
      method: 'POST',
      url: '/api/bu/vitality/patient/orders',
      token: tokens.patient!,
      payload: {
        packageId: pkg.id,
        shippingAddress: TEST_ADDRESS,
        shippingMethod: 'ground',
      },
      expect: 201,
    });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sessionId = `cs_test_${suffix}`;
    const accountId = 'acct_test_qinio_vitality';
    const eventId = `evt_test_${suffix}`;

    await withPlatformScope(async (tx) => {
      const [businessUnit] = await tx
        .select({ id: businessUnits.id })
        .from(businessUnits)
        .where(eq(businessUnits.slug, 'vitality'))
        .limit(1);
      await tx
        .insert(paymentAccounts)
        .values({
          businessUnitId: businessUnit!.id,
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
        businessUnitId: businessUnit!.id,
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

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signature,
        },
        payload,
      });
      expect(response.statusCode).toBe(200);
    }

    const result = await withPlatformScope(async (tx) => {
      const [eventCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(paymentEvents)
        .where(eq(paymentEvents.providerEventId, eventId));
      const [kitCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(kits)
        .where(eq(kits.orderId, order.id));
      const [savedOrder] = await tx
        .select({ status: orders.status, paymentStatus: orders.paymentStatus })
        .from(orders)
        .where(eq(orders.id, order.id))
        .limit(1);
      return { eventCount: eventCount!.count, kitCount: kitCount!.count, savedOrder };
    });
    expect(result.eventCount).toBe(1);
    expect(result.kitCount).toBe(pkg.kitCount);
    expect(result.savedOrder).toMatchObject({
      status: 'dispatched_to_fulfillment',
      paymentStatus: 'paid',
    });
  });

  it('rejects an invalid webhook signature', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'invalid',
      },
      payload: '{}',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('fulfillment labeling, tracking, and cancel', () => {
  it('records only kits that were actually labeled and lets tracking be corrected', async () => {
    const pkg = await findPackage(false);
    const { order } = await call<{ order: { id: string } }>(app, {
      method: 'POST',
      url: '/api/bu/vitality/patient/orders',
      token: tokens.patient!,
      payload: { packageId: pkg.id, shippingAddress: TEST_ADDRESS, shippingMethod: 'ground' },
      expect: 201,
    });
    await call(app, {
      method: 'POST',
      url: `/api/bu/vitality/patient/orders/${order.id}/pay`,
      token: tokens.patient!,
      payload: { paymentToken: 'tok_test' },
    });

    const first = await call<{ labeled: number }>(app, {
      method: 'POST',
      url: `/api/bu/vitality/fulfillment/orders/${order.id}/label`,
      token: tokens.fulfillment!,
    });
    expect(first.labeled).toBe(pkg.kitCount);

    const second = await call<{ labeled: number }>(app, {
      method: 'POST',
      url: `/api/bu/vitality/fulfillment/orders/${order.id}/label`,
      token: tokens.fulfillment!,
    });
    expect(second.labeled).toBe(0);

    await call(app, {
      method: 'POST',
      url: `/api/bu/vitality/fulfillment/orders/${order.id}/ship`,
      token: tokens.fulfillment!,
      payload: { carrier: 'UPS', trackingNumber: '1Z-ORIGINAL' },
    });

    const reship = await app.inject({
      method: 'POST',
      url: `/api/bu/vitality/fulfillment/orders/${order.id}/ship`,
      headers: auth(tokens.fulfillment!),
      payload: { carrier: 'FEDEX', trackingNumber: '1Z-AGAIN' },
    });
    expect(reship.statusCode).toBe(400);

    await call(app, {
      method: 'PATCH',
      url: `/api/bu/vitality/fulfillment/orders/${order.id}/shipment`,
      token: tokens.fulfillment!,
      payload: { carrier: 'USPS', trackingNumber: '9400-CORRECTED' },
    });

    const detail = await call<{
      shipments: Array<{ carrier: string; trackingNumber: string }>;
      events: Array<{ message: string }>;
    }>(app, {
      method: 'GET',
      url: `/api/bu/vitality/fulfillment/orders/${order.id}`,
      token: tokens.fulfillment!,
    });
    expect(detail.shipments[0]).toMatchObject({
      carrier: 'USPS',
      trackingNumber: '9400-CORRECTED',
    });
    expect(detail.events.some((event) => event.message.includes('Tracking updated'))).toBe(true);
  });

  it('cancels from fulfillment and rejects cancel after the lab has the sample', async () => {
    const pkg = await findPackage(false);
    const { order } = await call<{ order: { id: string } }>(app, {
      method: 'POST',
      url: '/api/bu/vitality/patient/orders',
      token: tokens.patient!,
      payload: { packageId: pkg.id, shippingAddress: TEST_ADDRESS, shippingMethod: 'ground' },
      expect: 201,
    });
    await call(app, {
      method: 'POST',
      url: `/api/bu/vitality/patient/orders/${order.id}/pay`,
      token: tokens.patient!,
      payload: { paymentToken: 'tok_test' },
    });

    await call(app, {
      method: 'POST',
      url: `/api/bu/vitality/orders/${order.id}/cancel`,
      token: tokens.admin!,
      payload: { reason: 'Patient requested stop' },
    });

    const cancelled = await call<{ orders: Array<{ id: string; status: string }> }>(app, {
      method: 'GET',
      url: '/api/bu/vitality/orders',
      token: tokens.admin!,
    });
    expect(cancelled.orders.find((row) => row.id === order.id)?.status).toBe('cancelled');

    const { orderId, kits } = await driveToLabBench(pkg);
    const late = await app.inject({
      method: 'POST',
      url: `/api/bu/vitality/orders/${orderId}/cancel`,
      headers: auth(tokens.admin!),
      payload: { reason: 'Too late' },
    });
    expect(late.statusCode).toBe(400);
    expect(kits.length).toBeGreaterThan(0);
  });
});

describe('state machine', () => {
  it('rejects transitions that skip a step', async () => {
    const pkg = await findPackage(false);
    const { order } = await call<{ order: { id: string } }>(app, {
      method: 'POST',
      url: '/api/bu/vitality/patient/orders',
      token: tokens.patient!,
      payload: { packageId: pkg.id, shippingAddress: TEST_ADDRESS, shippingMethod: 'ground' },
      expect: 201,
    });

    // Unpaid, so there are no kits and nothing for fulfillment to ship.
    const premature = await app.inject({
      method: 'POST',
      url: `/api/bu/vitality/fulfillment/orders/${order.id}/ship`,
      headers: auth(tokens.fulfillment!),
      payload: { carrier: 'UPS', trackingNumber: '1Z-early' },
    });
    expect(premature.statusCode).toBe(400);
  });
});
