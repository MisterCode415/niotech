import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { normalizeHostname, verificationRecordValue } from '@nio/shared';
import { buildApp } from '../app.js';
import { findPublicBusinessUnit } from '../auth/context.js';
import { devAuthProvider } from '../auth/index.js';
import { closeDb, withPlatformScope } from '../db/client.js';
import { businessUnitDomains, businessUnits } from '../db/schema.js';
import { clearHostCache } from '../lib/hostTenant.js';
import { dnsClient } from '../services/domains.js';
import { auth, call, login } from './harness.js';

let app: FastifyInstance;
const tokens: Record<string, string> = {};
let vitalityId: string;
let metabolicId: string;
const createdHosts: string[] = [];

const stamp = Date.now();
const hostFor = (label: string) => `${label}-${stamp}.clinic-test.com`;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  tokens.platform = await login(app, 'admin@niotech.test');
  tokens.admin = await login(app, 'admin@vitality.test');
  tokens.patient = await login(app, 'patient@vitality.test');
  vitalityId = (await findPublicBusinessUnit('vitality')).id;
  metabolicId = (await findPublicBusinessUnit('metabolic')).id;
});

afterAll(async () => {
  await withPlatformScope(async (tx) => {
    if (createdHosts.length > 0) {
      await tx.delete(businessUnitDomains).where(inArray(businessUnitDomains.hostname, createdHosts));
    }
    await tx.update(businessUnits).set({ brand: null }).where(eq(businessUnits.id, vitalityId));
  });
  clearHostCache();
  await app.close();
  await closeDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface DomainBody {
  domain: {
    id: string;
    hostname: string;
    status: string;
    isPrimary: boolean;
    dns: { txtName: string; txtValue: string; target: string };
  };
}

async function addDomain(businessUnitId: string, hostname: string) {
  createdHosts.push(hostname);
  return call<DomainBody>(app, {
    method: 'POST',
    url: `/api/platform/business-units/${businessUnitId}/domains`,
    token: tokens.platform!,
    payload: { hostname },
    expect: 201,
  });
}

/** DNS exactly as a tenant would publish it. */
function publishTxt(token: string) {
  vi.spyOn(dnsClient, 'resolveTxt').mockResolvedValue([[verificationRecordValue(token)]]);
  vi.spyOn(dnsClient, 'resolveCname').mockRejectedValue(Object.assign(new Error(), { code: 'ENODATA' }));
  vi.spyOn(dnsClient, 'resolve4').mockRejectedValue(Object.assign(new Error(), { code: 'ENODATA' }));
}

function unpublishTxt() {
  vi.spyOn(dnsClient, 'resolveTxt').mockRejectedValue(Object.assign(new Error(), { code: 'ENODATA' }));
  vi.spyOn(dnsClient, 'resolveCname').mockRejectedValue(Object.assign(new Error(), { code: 'ENODATA' }));
  vi.spyOn(dnsClient, 'resolve4').mockRejectedValue(Object.assign(new Error(), { code: 'ENODATA' }));
}

async function verify(domainId: string) {
  return call<{ domain: DomainBody['domain']; check: { verified: boolean } }>(app, {
    method: 'POST',
    url: `/api/platform/domains/${domainId}/verify`,
    token: tokens.platform!,
  });
}

/** Adds a domain and walks it through verification. */
async function activeDomain(businessUnitId: string, label: string) {
  const { domain } = await addDomain(businessUnitId, hostFor(label));
  publishTxt(domain.dns.txtValue.replace('qinio-verify=', ''));
  const result = await verify(domain.id);
  expect(result.domain.status).toBe('verified');
  return result.domain;
}

function onHost(hostname: string, url: string, init: { method?: 'GET' | 'POST' } = {}) {
  return app.inject({ method: init.method ?? 'GET', url, headers: { host: hostname } });
}

describe('hostname validation', () => {
  it('accepts bare hostnames and rejects anything that is not one', () => {
    expect(normalizeHostname('Order.Clinic.COM.')).toBe('order.clinic.com');
    expect(normalizeHostname('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
    for (const bad of [
      'https://clinic.com',
      'clinic.com/path',
      'clinic.com:8443',
      'user@clinic.com',
      'localhost',
      '10.0.0.1',
      '-bad.clinic.com',
      'bad_name.clinic.com',
      'a..b.com',
      '',
    ]) {
      expect(normalizeHostname(bad), bad).toBeNull();
    }
  });
});

describe('domain onboarding', () => {
  it('lets only platform administrators manage domains', async () => {
    const body = { hostname: hostFor('nope') };
    for (const token of [tokens.admin!, tokens.patient!]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/platform/business-units/${vitalityId}/domains`,
        headers: auth(token),
        payload: body,
      });
      expect(response.statusCode).toBe(403);
    }
    expect(
      (await app.inject({ method: 'GET', url: `/api/platform/business-units/${vitalityId}/domains` }))
        .statusCode,
    ).toBe(401);
  });

  it('refuses platform hostnames, malformed input, and duplicates', async () => {
    const url = `/api/platform/business-units/${vitalityId}/domains`;
    for (const hostname of ['localhost', 'https://clinic.com', 'foo.localhost']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: auth(tokens.platform!),
        payload: { hostname },
      });
      expect(response.statusCode, hostname).toBe(400);
    }

    const hostname = hostFor('dupe');
    await addDomain(vitalityId, hostname);
    const again = await app.inject({
      method: 'POST',
      url: `/api/platform/business-units/${metabolicId}/domains`,
      headers: auth(tokens.platform!),
      payload: { hostname },
    });
    expect(again.statusCode).toBe(409);
  });

  it('stays pending until the TXT record proves control', async () => {
    const { domain } = await addDomain(vitalityId, hostFor('pending'));
    expect(domain.dns.txtName).toBe(`_qinio.${domain.hostname}`);

    unpublishTxt();
    const failed = await verify(domain.id);
    expect(failed.check.verified).toBe(false);
    expect(failed.domain.status).toBe('pending');

    // A record carrying someone else's token does not count.
    vi.spyOn(dnsClient, 'resolveTxt').mockResolvedValue([['qinio-verify=not-the-token']]);
    expect((await verify(domain.id)).domain.status).toBe('pending');

    // A pending domain neither resolves nor is approved for a certificate.
    expect((await onHost(domain.hostname, '/api/public/host')).statusCode).toBe(404);
    const gate = await app.inject({
      method: 'GET',
      url: `/api/internal/domain-allowed?domain=${domain.hostname}`,
    });
    expect(gate.statusCode).toBe(404);
  });

  it('activates on a matching record, registers the origin, and makes the first domain primary', async () => {
    const registerAppOrigin = vi.spyOn(devAuthProvider()!, 'registerAppOrigin');
    const domain = await activeDomain(vitalityId, 'live');
    expect(registerAppOrigin).toHaveBeenCalledWith(`https://${domain.hostname}`);

    const host = await onHost(domain.hostname, '/api/public/host');
    expect(host.statusCode).toBe(200);
    expect(host.json()).toMatchObject({ custom: true, slug: 'vitality', hostname: domain.hostname });

    const gate = await app.inject({
      method: 'GET',
      url: `/api/internal/domain-allowed?domain=${domain.hostname}`,
    });
    expect(gate.statusCode).toBe(200);
  });

  it('never approves certificates for the platform host or unknown names', async () => {
    for (const name of ['localhost', 'unknown-host.example.org', 'not a hostname']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/internal/domain-allowed?domain=${encodeURIComponent(name)}`,
      });
      expect(response.statusCode, name).toBe(404);
    }
  });
});

describe('host-pinned requests', () => {
  it('serves its own tenant and refuses everything else', async () => {
    const domain = await activeDomain(vitalityId, 'pin');

    const own = await onHost(domain.hostname, '/api/public/vitality/packages');
    expect(own.statusCode).toBe(200);

    // Another tenant's public and staff routes, and platform-wide routes, are unreachable here.
    for (const url of [
      '/api/public/metabolic/packages',
      '/api/bu/metabolic/summary',
      '/api/platform/business-units',
      '/api/workspaces',
      '/api/webhooks/stripe',
      '/api/internal/domain-allowed?domain=x.example.com',
    ]) {
      expect((await onHost(domain.hostname, url)).statusCode, url).toBe(404);
    }

    // The same URLs behave normally on the shared host.
    expect((await app.inject({ method: 'GET', url: '/api/public/metabolic/packages' })).statusCode).toBe(
      200,
    );
    expect((await onHost(domain.hostname, '/api/health')).statusCode).toBe(200);
  });

  it('keeps a patient session working on the tenant domain', async () => {
    const domain = await activeDomain(vitalityId, 'session');
    const response = await app.inject({
      method: 'GET',
      url: '/api/bu/vitality/patient/orders',
      headers: { ...auth(tokens.patient!), host: domain.hostname },
    });
    expect(response.statusCode).toBe(200);
  });

  it('stops serving when a domain is disabled and promotes another verified domain', async () => {
    const first = await activeDomain(vitalityId, 'first');
    const second = await activeDomain(vitalityId, 'second');
    const unregisterAppOrigin = vi.spyOn(devAuthProvider()!, 'unregisterAppOrigin');

    // Domains from earlier tests may already hold primary; make `first` the primary explicitly.
    await call(app, {
      method: 'POST',
      url: `/api/platform/domains/${first.id}/primary`,
      token: tokens.platform!,
    });

    const disabled = await call<DomainBody>(app, {
      method: 'POST',
      url: `/api/platform/domains/${first.id}/disable`,
      token: tokens.platform!,
    });
    expect(disabled.domain).toMatchObject({ status: 'disabled', isPrimary: false });
    expect(unregisterAppOrigin).toHaveBeenCalledWith(`https://${first.hostname}`);
    expect((await onHost(first.hostname, '/api/public/host')).statusCode).toBe(404);
    expect((await onHost(second.hostname, '/api/public/host')).statusCode).toBe(200);

    const list = await call<{ domains: Array<{ isPrimary: boolean }> }>(app, {
      method: 'GET',
      url: `/api/bu/vitality/domains`,
      token: tokens.admin!,
    });
    expect(list.domains.filter((d) => d.isPrimary)).toHaveLength(1);
  });

  it('refuses a primary that is not verified', async () => {
    const { domain } = await addDomain(vitalityId, hostFor('unverified-primary'));
    const response = await app.inject({
      method: 'POST',
      url: `/api/platform/domains/${domain.id}/primary`,
      headers: auth(tokens.platform!),
    });
    expect(response.statusCode).toBe(400);
  });

  it('closes every domain of a suspended business unit at once', async () => {
    const domain = await activeDomain(metabolicId, 'suspend');
    expect((await onHost(domain.hostname, '/api/public/host')).statusCode).toBe(200);

    await call(app, {
      method: 'PATCH',
      url: `/api/platform/business-units/${metabolicId}/status`,
      token: tokens.platform!,
      payload: { status: 'suspended' },
    });
    try {
      expect((await onHost(domain.hostname, '/api/public/host')).statusCode).toBe(404);
    } finally {
      await call(app, {
        method: 'PATCH',
        url: `/api/platform/business-units/${metabolicId}/status`,
        token: tokens.platform!,
        payload: { status: 'active' },
      });
    }
    expect((await onHost(domain.hostname, '/api/public/host')).statusCode).toBe(200);
  });
});

describe('white-label links and branding', () => {
  it('points checkout handoff links at the tenant primary domain', async () => {
    const domain = await activeDomain(vitalityId, 'handoff');
    await call(app, {
      method: 'POST',
      url: `/api/platform/domains/${domain.id}/primary`,
      token: tokens.platform!,
    });

    const catalog = await app
      .inject({ method: 'GET', url: '/api/public/vitality/packages' })
      .then((r) => r.json() as { packages: Array<{ id: string }> });
    const intent = await app.inject({
      method: 'POST',
      url: '/api/public/vitality/checkout-intents',
      payload: { packageId: catalog.packages[0]!.id },
    });
    expect(intent.statusCode).toBe(201);
    expect(intent.json().url).toMatch(new RegExp(`^https://${domain.hostname}/vitality/buy/`));
  });

  it('stores a validated brand and exposes it to anonymous pages and the host lookup', async () => {
    const domain = await activeDomain(vitalityId, 'brand');

    for (const bad of [
      { primaryColor: 'blue' },
      { primaryColor: '#12345' },
      { logoUrl: 'http://insecure.example.com/logo.png' },
      { logoUrl: 'javascript:alert(1)' },
      { displayName: '' },
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/bu/vitality/brand',
        headers: auth(tokens.admin!),
        payload: bad,
      });
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
    }

    const brand = {
      displayName: 'Vitality Clinic',
      logoUrl: 'https://cdn.vitality-clinic.test/logo.png',
      primaryColor: '#0f766e',
    };
    await call(app, {
      method: 'PUT',
      url: '/api/bu/vitality/brand',
      token: tokens.admin!,
      payload: brand,
    });

    const packages = await app.inject({ method: 'GET', url: '/api/public/vitality/packages' });
    expect(packages.json().businessUnit.brand).toEqual(brand);

    const host = await onHost(domain.hostname, '/api/public/host');
    expect(host.json().brand).toEqual(brand);

    // Other roles cannot change it.
    const forbidden = await app.inject({
      method: 'PUT',
      url: '/api/bu/vitality/brand',
      headers: auth(tokens.patient!),
      payload: brand,
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('reports no custom domain on the shared host', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/public/host' });
    expect(response.json()).toEqual({ custom: false });
  });
});
