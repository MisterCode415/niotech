import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { normalizeKitSerial } from '@nio/shared';
import { buildApp } from '../app.js';
import { closeDb, withPlatformScope, withTenant } from '../db/client.js';
import type { Actor, ActorMembership } from '../auth/context.js';
import { businessUnits, memberships, orderEvents, users } from '../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { requireScanOrganization } from '../routes/scan.js';
import { auth, call, login, TEST_ADDRESS } from './harness.js';

interface Kit {
  id: string;
  status: string;
  qrToken: string;
  serial: string;
}

interface ScanView {
  role: string | null;
  roleChoices: string[];
  outcome: string;
  redirect: string | null;
  caughtUp: string[];
  kit: { id: string; status: string; serial: string };
  order: { id: string; status: string };
  actions: Array<{ id: string }>;
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
    metabolicAdmin: 'admin@metabolic.test',
  })) {
    tokens[key] = await login(app, email);
  }
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

/** A single-kit, no-doctor order walked to `stage`, so order status mirrors the one kit. */
async function orderAt(stage: 'labeled' | 'shipped'): Promise<{ orderId: string; kit: Kit }> {
  const listing = await app
    .inject({ method: 'GET', url: '/api/public/vitality/packages' })
    .then((r) => r.json() as { packages: Array<{ id: string; name: string }> });
  const pkg = listing.packages.find((p) => p.name === 'Baseline Metabolic Check');
  if (!pkg) throw new Error('Seeded single-kit package not found');

  const { order } = await call<{ order: { id: string } }>(app, {
    method: 'POST',
    url: '/api/bu/vitality/patient/orders',
    token: tokens.patient!,
    payload: { packageId: pkg.id, shippingAddress: TEST_ADDRESS, shippingMethod: 'two_day' },
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
    url: `/api/bu/vitality/fulfillment/orders/${order.id}/correlate`,
    token: tokens.fulfillment!,
    payload: { externalOrderId: `SCAN-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  await call(app, {
    method: 'POST',
    url: `/api/bu/vitality/fulfillment/orders/${order.id}/label`,
    token: tokens.fulfillment!,
  });
  if (stage === 'shipped') {
    await call(app, {
      method: 'POST',
      url: `/api/bu/vitality/fulfillment/orders/${order.id}/ship`,
      token: tokens.fulfillment!,
      payload: { carrier: 'UPS', trackingNumber: `1Z${Date.now()}` },
    });
  }

  const detail = await call<{ kits: Kit[] }>(app, {
    method: 'GET',
    url: `/api/bu/vitality/patient/orders/${order.id}`,
    token: tokens.patient!,
  });
  return { orderId: order.id, kit: detail.kits[0]! };
}

async function scan(
  token: string,
  code: string,
  body: Record<string, unknown> = {},
  expectStatus = 200,
) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/scan/${encodeURIComponent(code)}`,
    headers: auth(token),
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(expectStatus);
  return response.json() as ScanView;
}

/** How someone might type a serial off a box: lowercase, no dashes, a zero read as the letter O. */
function sloppy(serial: string): string {
  return serial.replace(/^QK-/, '').replace(/-/g, ' ').toLowerCase().replace(/0/g, 'o');
}

describe('kit serials', () => {
  it('normalizes what people type off a label', () => {
    expect(normalizeKitSerial('qk 7f3k 9m2p')).toBe('QK-7F3K-9M2P');
    expect(normalizeKitSerial('7F3K-9M2O')).toBe('QK-7F3K-9M20');
    expect(normalizeKitSerial('7f3k9m2l')).toBe('QK-7F3K-9M21');
    expect(normalizeKitSerial('QK-7F3K')).toBeNull();
    expect(normalizeKitSerial('not a serial')).toBeNull();
  });
});

describe('scanning drives the custody chain', () => {
  let shippedOrder: { orderId: string; kit: Kit };

  it('registers receipt when the patient scans a shipped kit, and repeat scans change nothing', async () => {
    shippedOrder = await orderAt('shipped');
    const first = await scan(tokens.patient!, shippedOrder.kit.qrToken);
    expect(first.role).toBe('patient');
    expect(first.outcome).toBe('registered_received');
    expect(first.caughtUp).toEqual([]);
    expect(first.kit.status).toBe('received_by_patient');
    expect(first.order.status).toBe('kit_received_by_patient');
    expect(first.actions.map((a) => a.id)).toEqual(['send_to_lab']);

    const again = await scan(tokens.patient!, shippedOrder.kit.qrToken);
    expect(again.outcome).toBe('none');
    expect(again.kit.status).toBe('received_by_patient');
  });

  it('catches up shipping when the patient enters the serial of a kit nobody marked shipped', async () => {
    const { orderId, kit } = await orderAt('labeled');
    expect(kit.status).toBe('labeled');

    const view = await scan(tokens.patient!, sloppy(kit.serial));
    expect(view.kit.serial).toBe(kit.serial);
    expect(view.outcome).toBe('registered_received');
    expect(view.caughtUp).toEqual(['shipped']);
    expect(view.order.status).toBe('kit_received_by_patient');

    const events = await withPlatformScope((tx) =>
      tx
        .select({ metadata: orderEvents.metadata })
        .from(orderEvents)
        .where(eq(orderEvents.orderId, orderId)),
    );
    expect(
      events.some(
        (e) =>
          (e.metadata as { advancedByScan?: { role: string } } | null)?.advancedByScan?.role ===
          'patient',
      ),
    ).toBe(true);
  });

  it('checks the kit in when the lab scans it, then sends the second scan to the upload screen', async () => {
    const checkIn = await scan(tokens.lab!, shippedOrder.kit.qrToken);
    expect(checkIn.role).toBe('lab');
    expect(checkIn.outcome).toBe('checked_in');
    // The patient never pressed "I've mailed my sample"; the lab holding it proves they did.
    expect(checkIn.caughtUp).toEqual(['sample_in_transit']);
    expect(checkIn.kit.status).toBe('received_by_lab');
    expect(checkIn.order.status).toBe('received_by_lab');

    const second = await scan(tokens.lab!, shippedOrder.kit.serial);
    expect(second.outcome).toBe('open_for_results');
    expect(second.redirect).toBe(
      `/w/vitality/lab/orders/${shippedOrder.orderId}?kit=${shippedOrder.kit.id}`,
    );
    expect(second.kit.status).toBe('received_by_lab');
  });

  it('treats another tenant’s kit as unknown', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/scan/${shippedOrder.kit.serial}`,
      headers: auth(tokens.metabolicAdmin!),
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it('asks a person with several roles which one they are scanning as', async () => {
    const { orderId, kit } = await orderAt('labeled');
    const [unit] = await withPlatformScope((tx) =>
      tx
        .select({ id: businessUnits.id })
        .from(businessUnits)
        .where(eq(businessUnits.slug, 'vitality')),
    );
    const email = `multi-${Date.now()}@vitality.test`;
    const [user] = await withPlatformScope((tx) =>
      tx.insert(users).values({ email, name: 'Lab And Fulfillment', status: 'active' }).returning(),
    );
    await withTenant({ businessUnitId: unit!.id, userId: user!.id, actorRole: 'system' }, (tx) =>
      tx.insert(memberships).values([
        { userId: user!.id, businessUnitId: unit!.id, role: 'lab' },
        { userId: user!.id, businessUnitId: unit!.id, role: 'fulfillment' },
      ]),
    );

    try {
      const token = await login(app, email);
      const ask = await scan(token, kit.qrToken);
      expect(ask.role).toBeNull();
      expect(ask.roleChoices.sort()).toEqual(['fulfillment', 'lab']);
      expect(ask.kit.status).toBe('labeled');

      const asFulfillment = await scan(token, kit.qrToken, { as: 'fulfillment' });
      expect(asFulfillment.outcome).toBe('open_order');
      expect(asFulfillment.redirect).toBe(`/w/vitality/fulfillment/orders/${orderId}`);
      expect(asFulfillment.kit.status).toBe('labeled');
    } finally {
      await withPlatformScope((tx) => tx.delete(users).where(eq(users.id, user!.id)));
    }
  });
});

describe('scan organization scope', () => {
  const membership = {
    businessUnitName: 'Vitality Health',
    auth0OrgId: 'org_vitality',
  } as ActorMembership;

  it('names the organization to sign in to when an Auth0 session has none', () => {
    const actor = {
      identity: { provider: 'auth0', subject: 'auth0|lab', email: 'lab@example.test' },
    } as Actor;
    try {
      requireScanOrganization(actor, membership);
      throw new Error('expected ORGANIZATION_REQUIRED');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const httpError = error as HttpError;
      expect(httpError.statusCode).toBe(409);
      expect(httpError.code).toBe('ORGANIZATION_REQUIRED');
      expect(httpError.details).toEqual({ organization: 'org_vitality' });
    }
  });

  it('accepts a session already scoped to the kit organization', () => {
    const actor = {
      identity: {
        provider: 'auth0',
        subject: 'auth0|lab',
        email: 'lab@example.test',
        orgId: 'org_vitality',
      },
    } as Actor;
    expect(() => requireScanOrganization(actor, membership)).not.toThrow();
  });
});
