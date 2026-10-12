import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { closeDb, withPlatformScope } from '../db/client.js';
import { phiAccessEvents } from '../db/schema.js';
import { toCsv } from '../lib/csv.js';
import { auth, call, login, releaseDirectOrder } from './harness.js';
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

async function exportRows(orderId: string) {
  return withPlatformScope((tx) =>
    tx
      .select()
      .from(phiAccessEvents)
      .where(
        and(
          eq(phiAccessEvents.orderId, orderId),
          eq(phiAccessEvents.resourceType, 'disclosure_export'),
        ),
      ),
  );
}

describe('csv writer', () => {
  it('quotes awkward cells and neutralises spreadsheet formulas', () => {
    const csv = toCsv(['a', 'b'], [
      { a: 'plain', b: 'has, comma and "quote"' },
      { a: '=HYPERLINK("http://evil")', b: null },
    ]);
    expect(csv.split('\r\n')).toEqual([
      'a,b',
      'plain,"has, comma and ""quote"""',
      `"'=HYPERLINK(""http://evil"")",`,
      '',
    ]);
  });
});

describe('accounting of disclosures export', () => {
  it('lists who opened a patient’s results, as JSON, and records the lookup itself', async () => {
    const { orderId, fileId } = await releaseDirectOrder(app, tokens);
    await app.inject({
      method: 'GET',
      url: `/api/bu/vitality/patient/orders/${orderId}/results/${fileId}`,
      headers: auth(tokens.patient!),
    });

    const body = await call<{
      entries: Array<{ source: string; action: string; resource: string; actorEmail: string | null }>;
      orderCount: number;
    }>(app, {
      method: 'GET',
      url: `/api/bu/vitality/audit/disclosures?orderId=${orderId}`,
      token: tokens.admin!,
    });
    expect(body.orderCount).toBe(1);
    expect(body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'phi_access',
          resource: 'result_file',
          action: 'download',
          actorEmail: 'patient@vitality.test',
        }),
        expect.objectContaining({ source: 'order_event', action: 'results_released' }),
      ]),
    );
    // The export does not list itself, but it is on the trail afterwards.
    expect(body.entries.some((entry) => entry.resource === 'disclosure_export')).toBe(false);
    const rows = await exportRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorRole: 'bu_admin', action: 'view' });
  });

  it('finds orders by patient email and returns a CSV download that is itself audited', async () => {
    const { orderId } = await releaseDirectOrder(app, tokens);

    const response = await app.inject({
      method: 'GET',
      url: `/api/bu/vitality/audit/disclosures?patientEmail=patient@vitality.test&format=csv`,
      headers: auth(tokens.admin!),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['cache-control']).toBe('no-store');
    const [header] = response.body.split('\r\n');
    expect(header).toBe(
      'at,source,orderId,actorEmail,actorRole,actingPlatformAdmin,resource,action,detail,requestId,ip',
    );
    expect(response.body).toContain(orderId);

    // A patient-wide export has no single order, so find it by action instead.
    const exported = await withPlatformScope((tx) =>
      tx
        .select()
        .from(phiAccessEvents)
        .where(
          and(
            eq(phiAccessEvents.resourceType, 'disclosure_export'),
            eq(phiAccessEvents.action, 'export'),
          ),
        ),
    );
    expect(exported.length).toBeGreaterThan(0);
    expect(exported[0]).toMatchObject({ actorRole: 'bu_admin', orderId: null });
  });

  it('refuses everyone but the business unit admin', async () => {
    const { orderId } = await releaseDirectOrder(app, tokens);
    for (const token of [tokens.patient!, tokens.lab!, tokens.fulfillment!]) {
      await call(app, {
        method: 'GET',
        url: `/api/bu/vitality/audit/disclosures?orderId=${orderId}`,
        token,
        expect: 403,
      });
    }
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/bu/vitality/audit/disclosures?orderId=${orderId}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('needs a patient email or an order id, and rejects an unknown order', async () => {
    await call(app, {
      method: 'GET',
      url: '/api/bu/vitality/audit/disclosures',
      token: tokens.admin!,
      expect: 400,
    });
    await call(app, {
      method: 'GET',
      url: '/api/bu/vitality/audit/disclosures?orderId=00000000-0000-4000-8000-000000000000',
      token: tokens.admin!,
      expect: 404,
    });
  });
});
