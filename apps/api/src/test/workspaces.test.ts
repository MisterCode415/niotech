import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, like } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { closeDb, withPlatformScope, withTenant } from '../db/client.js';
import { devAuthProvider } from '../auth/index.js';
import { env } from '../env.js';
import { businessUnits, memberships, orderEvents, orders, packages, users } from '../db/schema.js';
import { auth, login } from './harness.js';

let app: FastifyInstance;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  for (const [key, email] of Object.entries({
    platform: 'admin@niotech.test',
    admin: 'admin@vitality.test',
    lab: 'lab@vitality.test',
    patient: 'patient@vitality.test',
  })) {
    tokens[key] = await login(app, email);
  }
});

afterAll(async () => {
  await app.inject({
    method: 'DELETE',
    url: '/api/bu/vitality/simulation',
    headers: auth(tokens.admin!),
  });
  await app.close();
  await closeDb();
});

function actAs(token: string, value: string) {
  return { ...auth(token), 'x-qinio-act-as': value };
}

async function systemScope() {
  const [admin] = await withPlatformScope((tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, 'admin@vitality.test')),
  );
  return { businessUnitId: await vitalityId(), userId: admin!.id, actorRole: 'system' as const };
}

async function vitalityId(): Promise<string> {
  const [row] = await withPlatformScope((tx) =>
    tx
      .select({ id: businessUnits.id })
      .from(businessUnits)
      .where(eq(businessUnits.slug, 'vitality')),
  );
  return row!.id;
}

describe('platform admin act-as', () => {
  it('lets an organization-less superadmin work any queue only when the header names it', async () => {
    const without = await app.inject({
      method: 'GET',
      url: '/api/bu/vitality/lab/queue',
      headers: auth(tokens.platform!),
    });
    expect([403, 404]).toContain(without.statusCode);

    const asLab = await app.inject({
      method: 'GET',
      url: '/api/bu/vitality/lab/queue',
      headers: actAs(tokens.platform!, 'vitality:lab'),
    });
    expect(asLab.statusCode).toBe(200);

    // The header grants exactly one role in exactly one business unit.
    const wrongRole = await app.inject({
      method: 'GET',
      url: '/api/bu/vitality/doctor/queue',
      headers: actAs(tokens.platform!, 'vitality:lab'),
    });
    expect([403, 404]).toContain(wrongRole.statusCode);

    const wrongUnit = await app.inject({
      method: 'GET',
      url: '/api/bu/metabolic/lab/queue',
      headers: actAs(tokens.platform!, 'vitality:lab'),
    });
    expect([403, 404]).toContain(wrongUnit.statusCode);

    const malformed = await app.inject({
      method: 'GET',
      url: '/api/bu/vitality/lab/queue',
      headers: actAs(tokens.platform!, 'vitality:janitor'),
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('rejects the header from anyone who is not the platform admin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/bu/vitality/lab/queue',
      headers: actAs(tokens.patient!, 'vitality:lab'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects the header from a superadmin token scoped to an organization', async () => {
    const orgScoped = await devAuthProvider()!.issueToken({
      provider: 'dev',
      subject: 'dev|admin@niotech.test',
      email: 'admin@niotech.test',
      name: 'Platform Admin',
      orgId: 'org_dev_vitality',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/bu/vitality/lab/queue',
      headers: actAs(orgScoped, 'vitality:lab'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('lists every business unit and role as act-as workspaces for the superadmin only', async () => {
    const platform = await app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers: auth(tokens.platform!),
    });
    const platformWorkspaces = platform.json().workspaces as Array<{
      businessUnitSlug: string;
      role: string;
      actAs: boolean;
    }>;
    const vitality = platformWorkspaces.filter((w) => w.businessUnitSlug === 'vitality');
    expect(vitality.map((w) => w.role).sort()).toEqual([
      'bu_admin',
      'doctor',
      'fulfillment',
      'lab',
      'patient',
    ]);
    expect(vitality.every((w) => w.actAs)).toBe(true);

    const lab = await app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers: auth(tokens.lab!),
    });
    const labWorkspaces = lab.json().workspaces as Array<{
      businessUnitSlug: string;
      role: string;
      actAs: boolean;
    }>;
    expect(labWorkspaces).toContainEqual(
      expect.objectContaining({ businessUnitSlug: 'vitality', role: 'lab', actAs: false }),
    );
    expect(labWorkspaces.every((w) => !w.actAs)).toBe(true);
    expect(
      labWorkspaces.some((w) => w.businessUnitSlug === 'vitality' && w.role === 'bu_admin'),
    ).toBe(false);
  });
});

describe('access issues', () => {
  it('explains a suspended membership instead of an empty workspace list', async () => {
    const businessUnitId = await vitalityId();
    const email = `suspended-${Date.now()}@vitality.test`;
    const [user] = await withPlatformScope((tx) =>
      tx.insert(users).values({ email, name: 'Suspended Lab', status: 'active' }).returning(),
    );
    await withTenant({ businessUnitId, userId: user!.id, actorRole: 'system' }, (tx) =>
      tx
        .insert(memberships)
        .values({ userId: user!.id, businessUnitId, role: 'lab', status: 'suspended' }),
    );

    try {
      const token = await login(app, email);
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(token) });
      expect(me.statusCode).toBe(200);
      const body = me.json() as { memberships: unknown[]; accessIssues: Array<{ code: string }> };
      expect(body.memberships).toEqual([]);
      expect(body.accessIssues.map((issue) => issue.code)).toContain('membership_suspended');

      const healthy = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: auth(tokens.lab!),
      });
      expect(healthy.json().accessIssues).toEqual([]);
    } finally {
      await withPlatformScope((tx) => tx.delete(users).where(eq(users.id, user!.id)));
    }
  });
});

describe('mock flow', () => {
  it('is refused to non-admins and when the flag is off', async () => {
    const asLab = await app.inject({
      method: 'POST',
      url: '/api/bu/vitality/simulation/seed',
      headers: auth(tokens.lab!),
    });
    expect(asLab.statusCode).toBe(403);

    const original = env.SIMULATION_ENABLED;
    env.SIMULATION_ENABLED = false;
    try {
      const disabled = await app.inject({
        method: 'POST',
        url: '/api/bu/vitality/simulation/seed',
        headers: auth(tokens.admin!),
      });
      expect(disabled.statusCode).toBe(403);

      const config = await app.inject({ method: 'GET', url: '/api/auth/config' });
      expect(config.json().simulationEnabled).toBe(false);
    } finally {
      env.SIMULATION_ENABLED = original;
    }
  });

  it('seeds every queue through the superadmin act-as, audits it, and clears only mock data', async () => {
    const businessUnitId = await vitalityId();
    const realBefore = await withTenant(await systemScope(), (tx) =>
      tx.select({ id: orders.id }).from(orders).where(eq(orders.isMock, false)),
    );

    const seed = await app.inject({
      method: 'POST',
      url: '/api/bu/vitality/simulation/seed',
      headers: actAs(tokens.platform!, 'vitality:bu_admin'),
    });
    expect(seed.statusCode).toBe(201);
    const seeded = seed.json().orders as Array<{ orderNumber: string; status: string }>;
    expect(new Set(seeded.map((o) => o.status))).toEqual(
      new Set([
        'dispatched_to_fulfillment',
        'kit_shipped',
        'kit_received_by_patient',
        'sample_in_transit',
        'received_by_lab',
        'lab_processing',
        'awaiting_clinician_review',
        'results_released',
      ]),
    );

    const mockOrders = await withTenant(await systemScope(), (tx) =>
      tx
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(eq(orders.isMock, true)),
    );
    expect(mockOrders.length).toBe(seeded.length);
    for (const order of seeded) {
      expect(mockOrders.some((row) => row.status === order.status)).toBe(true);
    }

    const events = await withTenant(await systemScope(), (tx) =>
      tx
        .select({ metadata: orderEvents.metadata })
        .from(orderEvents)
        .where(
          inArray(
            orderEvents.orderId,
            mockOrders.map((o) => o.id),
          ),
        ),
    );
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (e) => (e.metadata as { actingAsPlatformAdmin?: unknown })?.actingAsPlatformAdmin,
      ),
    ).toBe(true);

    const queue = async (url: string, role: string) => {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: actAs(tokens.platform!, `vitality:${role}`),
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    const fulfillment = (await queue('/api/bu/vitality/fulfillment/orders', 'fulfillment')) as {
      orders: Array<{ isMock: boolean; status: string }>;
    };
    expect(
      fulfillment.orders.some((o) => o.isMock && o.status === 'dispatched_to_fulfillment'),
    ).toBe(true);
    const lab = (await queue('/api/bu/vitality/lab/queue', 'lab')) as {
      kits?: Array<{ isMock: boolean }>;
    };
    expect(JSON.stringify(lab)).toContain('"isMock":true');
    const doctor = (await queue('/api/bu/vitality/doctor/queue', 'doctor')) as {
      pending: Array<{ isMock: boolean }>;
    };
    expect(doctor.pending.some((o) => o.isMock)).toBe(true);

    const clear = await app.inject({
      method: 'DELETE',
      url: '/api/bu/vitality/simulation',
      headers: auth(tokens.admin!),
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().removedOrders).toBe(seeded.length);

    const after = await withTenant(await systemScope(), async (tx) => ({
      mock: await tx.select({ id: orders.id }).from(orders).where(eq(orders.isMock, true)),
      real: await tx.select({ id: orders.id }).from(orders).where(eq(orders.isMock, false)),
      mockPackages: await tx
        .select({ id: packages.id })
        .from(packages)
        .where(
          and(
            eq(packages.businessUnitId, businessUnitId),
            like(packages.internalReference, 'QINIO-MOCK-%'),
          ),
        ),
    }));
    expect(after.mock).toEqual([]);
    expect(after.mockPackages).toEqual([]);
    expect(after.real.length).toBe(realBefore.length);

    const leftoverPatients = await withPlatformScope((tx) =>
      tx.select({ id: users.id }).from(users).where(like(users.email, 'mock+vitality-%')),
    );
    expect(leftoverPatients).toEqual([]);
  });
});
