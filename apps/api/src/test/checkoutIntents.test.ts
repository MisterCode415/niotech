import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { isAllowedReturnUrl, normalizeOrigin } from '@nio/shared';
import { buildApp } from '../app.js';
import { closeDb, withPlatformScope } from '../db/client.js';
import { checkoutIntents, orders, packages } from '../db/schema.js';
import { auth, call, login, TEST_ADDRESS } from './harness.js';

let app: FastifyInstance;
const tokens: Record<string, string> = {};

const ORIGIN = 'https://shop.vitality-clinic.test';

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  tokens.admin = await login(app, 'admin@vitality.test');
  tokens.patient = await login(app, 'patient@vitality.test');
  await call(app, {
    method: 'PUT',
    url: '/api/bu/vitality/marketing-origins',
    token: tokens.admin!,
    payload: { origins: [`${ORIGIN}/some/path`] },
  });
});

afterAll(async () => {
  await call(app, {
    method: 'PUT',
    url: '/api/bu/vitality/marketing-origins',
    token: tokens.admin!,
    payload: { origins: [] },
  });
  await app.close();
  await closeDb();
});

async function activePackageId(slug: string): Promise<string> {
  const response = await app.inject({ method: 'GET', url: `/api/public/${slug}/packages` });
  const catalog = response.json() as { packages: Array<{ id: string }> };
  return catalog.packages[0]!.id;
}

function createIntent(slug: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/public/${slug}/checkout-intents`,
    payload: payload as object,
  });
}

describe('origin helpers', () => {
  it('reduces a URL to its origin and rejects unsafe schemes and credentials', () => {
    expect(normalizeOrigin('https://Shop.Example.com/path?q=1')).toBe('https://shop.example.com');
    expect(normalizeOrigin('http://localhost:3000/x')).toBe('http://localhost:3000');
    expect(normalizeOrigin('http://shop.example.com')).toBeNull();
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('https://user:pw@shop.example.com')).toBeNull();
    expect(normalizeOrigin('not a url')).toBeNull();
  });

  it('matches on the parsed origin, never on a string prefix', () => {
    const allowed = ['https://shop.example.com'];
    expect(isAllowedReturnUrl('https://shop.example.com/thanks', allowed)).toBe(true);
    expect(isAllowedReturnUrl('https://shop.example.com.evil.test/', allowed)).toBe(false);
    expect(isAllowedReturnUrl('https://shop.example.com@evil.test/', allowed)).toBe(false);
    expect(isAllowedReturnUrl('//evil.test/', allowed)).toBe(false);
  });
});

describe('marketing origins admin', () => {
  it('stores canonical origins and rejects invalid entries', async () => {
    const saved = await call<{ origins: string[] }>(app, {
      method: 'GET',
      url: '/api/bu/vitality/marketing-origins',
      token: tokens.admin!,
    });
    expect(saved.origins).toEqual([ORIGIN]);

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/bu/vitality/marketing-origins',
      headers: auth(tokens.admin!),
      payload: { origins: ['http://insecure.example.com'] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('is limited to the business unit admin', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/bu/vitality/marketing-origins',
      headers: auth(tokens.patient!),
      payload: { origins: [ORIGIN] },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('checkout intents', () => {
  it('creates an intent, returns a Qinio buy link, and resolves it with attribution', async () => {
    const packageId = await activePackageId('vitality');
    const created = await createIntent('vitality', {
      packageId,
      returnUrl: `${ORIGIN}/thanks`,
      attribution: { utm_source: 'newsletter', ref: 'spring', not_a_tag: 'dropped' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; url: string };
    expect(body.url).toContain(`/vitality/buy/${packageId}?intent=${body.id}`);

    const resolved = await app.inject({
      method: 'GET',
      url: `/api/public/vitality/checkout-intents/${body.id}`,
    });
    expect(resolved.statusCode).toBe(200);
    const { intent } = resolved.json() as {
      intent: { packageId: string; returnUrl: string; attribution: Record<string, string> };
    };
    expect(intent.packageId).toBe(packageId);
    expect(intent.returnUrl).toBe(`${ORIGIN}/thanks`);
    expect(intent.attribution).toEqual({ utm_source: 'newsletter', ref: 'spring' });
  });

  it('rejects a return URL that is not on the allowlist', async () => {
    const packageId = await activePackageId('vitality');
    for (const returnUrl of [
      'https://evil.test/phish',
      `${ORIGIN}.evil.test/`,
      'javascript:alert(1)',
    ]) {
      const response = await createIntent('vitality', { packageId, returnUrl });
      expect(response.statusCode).toBe(400);
    }
  });

  it('accepts an intent with no return URL', async () => {
    const response = await createIntent('vitality', { packageId: await activePackageId('vitality') });
    expect(response.statusCode).toBe(201);
  });

  it('refuses unknown or inactive packages', async () => {
    const unknown = await createIntent('vitality', {
      packageId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.statusCode).toBe(404);

    const packageId = await activePackageId('vitality');
    await withPlatformScope((tx) =>
      tx.update(packages).set({ status: 'draft' }).where(eq(packages.id, packageId)),
    );
    try {
      const inactive = await createIntent('vitality', { packageId });
      expect(inactive.statusCode).toBe(404);
    } finally {
      await withPlatformScope((tx) =>
        tx.update(packages).set({ status: 'active' }).where(eq(packages.id, packageId)),
      );
    }
  });

  it('stops resolving once expired', async () => {
    const created = await createIntent('vitality', {
      packageId: await activePackageId('vitality'),
    });
    const { id } = created.json() as { id: string };
    await withPlatformScope((tx) =>
      tx
        .update(checkoutIntents)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(checkoutIntents.id, id)),
    );

    const resolved = await app.inject({
      method: 'GET',
      url: `/api/public/vitality/checkout-intents/${id}`,
    });
    expect(resolved.statusCode).toBe(410);
  });

  it('does not resolve under another business unit’s slug', async () => {
    const created = await createIntent('vitality', {
      packageId: await activePackageId('vitality'),
    });
    const { id } = created.json() as { id: string };

    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/public/metabolic/checkout-intents/${id}`,
    });
    expect(crossTenant.statusCode).toBe(404);
  });

  it('drops a return URL once its origin leaves the allowlist', async () => {
    const created = await createIntent('vitality', {
      packageId: await activePackageId('vitality'),
      returnUrl: `${ORIGIN}/thanks`,
    });
    const { id } = created.json() as { id: string };

    await call(app, {
      method: 'PUT',
      url: '/api/bu/vitality/marketing-origins',
      token: tokens.admin!,
      payload: { origins: [] },
    });
    try {
      const resolved = await app.inject({
        method: 'GET',
        url: `/api/public/vitality/checkout-intents/${id}`,
      });
      expect(resolved.json().intent.returnUrl).toBeNull();
    } finally {
      await call(app, {
        method: 'PUT',
        url: '/api/bu/vitality/marketing-origins',
        token: tokens.admin!,
        payload: { origins: [ORIGIN] },
      });
    }
  });

  it('stores attribution on the order and marks the intent consumed', async () => {
    const packageId = await activePackageId('vitality');
    const created = await createIntent('vitality', {
      packageId,
      attribution: { utm_campaign: 'launch' },
    });
    const { id: intentId } = created.json() as { id: string };

    const { order } = await call<{ order: { id: string } }>(app, {
      method: 'POST',
      url: '/api/bu/vitality/patient/orders',
      token: tokens.patient!,
      payload: {
        packageId,
        shippingAddress: TEST_ADDRESS,
        shippingMethod: 'ground',
        attribution: { utm_campaign: 'launch', stray: 'dropped' },
        intentId,
      },
      expect: 201,
    });

    const [row] = await withPlatformScope((tx) =>
      tx.select({ attribution: orders.attribution }).from(orders).where(eq(orders.id, order.id)),
    );
    expect(row!.attribution).toEqual({ utm_campaign: 'launch' });

    const [intent] = await withPlatformScope((tx) =>
      tx.select().from(checkoutIntents).where(eq(checkoutIntents.id, intentId)),
    );
    expect(intent!.consumedAt).not.toBeNull();

    // Keep the shared database tidy: this order never reaches payment.
    await withPlatformScope(async (tx) => {
      await tx.delete(orders).where(eq(orders.id, order.id));
    });
  });
});
