import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { closeDb } from '../db/client.js';
import { clearEmbedCorsCache } from '../lib/embedCors.js';
import { call, login } from './harness.js';

let app: FastifyInstance;
let adminToken: string;

const SITE = 'https://www.vitality-clinic.test';
const OTHER = 'https://evil.test';

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  adminToken = await login(app, 'admin@vitality.test');
  await setOrigins([SITE]);
});

afterAll(async () => {
  await setOrigins([]);
  await app.close();
  await closeDb();
});

async function setOrigins(origins: string[]) {
  await call(app, {
    method: 'PUT',
    url: '/api/bu/vitality/marketing-origins',
    token: adminToken,
    payload: { origins },
  });
}

function preflight(url: string, origin: string, method = 'GET') {
  return app.inject({
    method: 'OPTIONS',
    url,
    headers: { origin, 'access-control-request-method': method },
  });
}

describe('catalog widget CORS', () => {
  it('lets a registered marketing origin read the catalog, without credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/public/vitality/packages',
      headers: { origin: SITE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(SITE);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers the preflight for the buy-button call', async () => {
    const response = await preflight('/api/public/vitality/checkout-intents', SITE, 'POST');
    expect(response.headers['access-control-allow-origin']).toBe(SITE);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('gives an unregistered origin nothing', async () => {
    for (const url of ['/api/public/vitality/packages', '/api/public/vitality/checkout-intents']) {
      const response = await preflight(url, OTHER, 'POST');
      expect(response.headers['access-control-allow-origin'], url).not.toBe(OTHER);
    }
  });

  it("does not let one tenant's origin call another tenant's widget routes", async () => {
    const response = await preflight('/api/public/metabolic/packages', SITE);
    expect(response.headers['access-control-allow-origin']).not.toBe(SITE);
  });

  it('never extends to authenticated or other public routes', async () => {
    for (const url of [
      '/api/bu/vitality/patient/orders',
      '/api/public/vitality/orders',
      '/api/public/vitality/page',
      '/api/auth/me',
    ]) {
      const response = await preflight(url, SITE, 'POST');
      expect(response.headers['access-control-allow-origin'], url).not.toBe(SITE);
    }
  });

  it('stops answering the moment an origin is removed', async () => {
    await setOrigins([]);
    const response = await preflight('/api/public/vitality/packages', SITE);
    expect(response.headers['access-control-allow-origin']).not.toBe(SITE);

    await setOrigins([SITE]);
    clearEmbedCorsCache();
    const restored = await preflight('/api/public/vitality/packages', SITE);
    expect(restored.headers['access-control-allow-origin']).toBe(SITE);
  });
});
