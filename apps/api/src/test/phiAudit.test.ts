import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { closeDb, withPlatformScope, withTenant } from '../db/client.js';
import { businessUnits, phiAccessEvents, users } from '../db/schema.js';
import { call, login, auth, releaseDirectOrder } from './harness.js';
import * as pdfExtract from '../services/pdfExtract.js';

let app: FastifyInstance;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  for (const [key, email] of Object.entries({
    patient: 'patient@vitality.test',
    fulfillment: 'fulfillment@vitality.test',
    lab: 'lab@vitality.test',
    admin: 'admin@vitality.test',
  })) {
    tokens[key] = await login(app, email);
  }
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(() => {
  vi.spyOn(pdfExtract.pdfOcr, 'ocrPdfPages').mockResolvedValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function auditRows(orderId: string) {
  return withPlatformScope((tx) =>
    tx.select().from(phiAccessEvents).where(eq(phiAccessEvents.orderId, orderId)),
  );
}

describe('PHI access audit', () => {
  it('records a patient PDF download with actor, resource, and request id', async () => {
    const { orderId, fileId } = await releaseDirectOrder(app, tokens);

    const response = await app.inject({
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${orderId}/results/${fileId}`,
      headers: auth(tokens.patient!),
    });
    expect(response.statusCode).toBe(200);

    const rows = (await auditRows(orderId)).filter((row) => row.action === 'download');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorRole: 'patient',
      actingPlatformAdmin: false,
      resourceType: 'result_file',
      resourceId: fileId,
    });
    expect(rows[0]!.actorUserId).toBeTruthy();
    expect(rows[0]!.requestId).toBe(response.headers['x-request-id']);
  });

  it('records a patient order view only once results are released', async () => {
    const { orderId } = await releaseDirectOrder(app, tokens);
    await call(app, {
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${orderId}`,
      token: tokens.patient!,
    });
    const rows = (await auditRows(orderId)).filter((row) => row.resourceType === 'order_detail');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorRole: 'patient', action: 'view' });
  });

  it('records the lab reading an order', async () => {
    const { orderId } = await releaseDirectOrder(app, tokens);
    await call(app, {
      method: 'GET',
      url: `/api/bu/vitality/lab/orders/${orderId}`,
      token: tokens.lab!,
    });
    const rows = (await auditRows(orderId)).filter((row) => row.actorRole === 'lab');
    expect(rows.map((row) => `${row.resourceType}:${row.action}`)).toContain('order_detail:view');
  });

  it('echoes a UUID request id and replaces anything else', async () => {
    const supplied = '3f2b8c0e-1d4a-4b6e-9c11-0a7d5e2f9b44';
    const kept = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': supplied },
    });
    expect(kept.headers['x-request-id']).toBe(supplied);

    const replaced = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'not a uuid\nINJECTED' },
    });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(replaced.headers['x-request-id']).not.toContain('INJECTED');
  });

  it('lets the business unit admin read the trail but not the patient', async () => {
    const { orderId, fileId } = await releaseDirectOrder(app, tokens);
    await app.inject({
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${orderId}/results/${fileId}`,
      headers: auth(tokens.patient!),
    });

    const [bu] = await withPlatformScope((tx) =>
      tx.select({ id: businessUnits.id }).from(businessUnits).where(eq(businessUnits.slug, 'vitality')),
    );
    const [patient] = await withPlatformScope((tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.email, 'patient@vitality.test')),
    );
    const [admin] = await withPlatformScope((tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.email, 'admin@vitality.test')),
    );

    const asAdmin = await withTenant(
      { businessUnitId: bu!.id, userId: admin!.id, actorRole: 'bu_admin' },
      (tx) => tx.select().from(phiAccessEvents).where(eq(phiAccessEvents.orderId, orderId)),
    );
    expect(asAdmin.length).toBeGreaterThan(0);

    const asPatient = await withTenant(
      { businessUnitId: bu!.id, userId: patient!.id, actorRole: 'patient' },
      (tx) => tx.select().from(phiAccessEvents).where(eq(phiAccessEvents.orderId, orderId)),
    );
    expect(asPatient).toHaveLength(0);
  });

  it('refuses to forge a row as someone else', async () => {
    const [bu] = await withPlatformScope((tx) =>
      tx.select({ id: businessUnits.id }).from(businessUnits).where(eq(businessUnits.slug, 'vitality')),
    );
    const [patient] = await withPlatformScope((tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.email, 'patient@vitality.test')),
    );
    const [admin] = await withPlatformScope((tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.email, 'admin@vitality.test')),
    );
    await expect(
      withTenant({ businessUnitId: bu!.id, userId: patient!.id, actorRole: 'patient' }, (tx) =>
        tx.insert(phiAccessEvents).values({
          businessUnitId: bu!.id,
          actorUserId: admin!.id,
          actorRole: 'bu_admin',
          resourceType: 'order_detail',
          action: 'view',
        }),
      ),
    ).rejects.toThrow();
  });

  it('is append-only: updates and deletes fail even with platform scope', async () => {
    const { orderId, fileId } = await releaseDirectOrder(app, tokens);
    await app.inject({
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${orderId}/results/${fileId}`,
      headers: auth(tokens.patient!),
    });
    const [row] = await auditRows(orderId);
    expect(row).toBeTruthy();

    await expect(
      withPlatformScope((tx) =>
        tx.update(phiAccessEvents).set({ ip: 'tampered' }).where(eq(phiAccessEvents.id, row!.id)),
      ),
    ).rejects.toThrow();
    await expect(
      withPlatformScope((tx) =>
        tx.delete(phiAccessEvents).where(eq(phiAccessEvents.id, row!.id)),
      ),
    ).rejects.toThrow();
  });

  it('does not put aiDraft in the patient order payload', async () => {
    const { orderId } = await releaseDirectOrder(app, tokens);
    const detail = await call<{ review: Record<string, unknown> | null }>(app, {
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${orderId}`,
      token: tokens.patient!,
    });
    expect(JSON.stringify(detail)).not.toContain('aiDraft');
    expect(JSON.stringify(detail)).not.toContain('aiModel');
  });
});
