import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { addDomainSchema, normalizeHostname } from '@nio/shared';
import { requirePlatformAdmin } from '../auth/context.js';
import { withPlatformScope } from '../db/client.js';
import { businessUnits } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import {
  addDomain,
  deleteDomain,
  disableDomain,
  isDomainApprovedForCertificate,
  listDomains,
  setPrimaryDomain,
  verifyDomain,
} from '../services/domains.js';

const buParam = z.object({ id: z.uuid() });
const domainParam = z.object({ domainId: z.uuid() });

export async function domainRoutes(app: FastifyInstance) {
  app.get('/api/platform/business-units/:id/domains', async (request) => {
    requirePlatformAdmin(request);
    const { id } = buParam.parse(request.params);
    await assertBusinessUnit(id);
    return { domains: await listDomains(id) };
  });

  app.post('/api/platform/business-units/:id/domains', async (request, reply) => {
    requirePlatformAdmin(request);
    const { id } = buParam.parse(request.params);
    const { hostname } = addDomainSchema.parse(request.body);
    await assertBusinessUnit(id);
    return reply.status(201).send({ domain: await addDomain(id, hostname) });
  });

  /** Re-checks DNS. Safe to call repeatedly while the tenant waits for propagation. */
  app.post('/api/platform/domains/:domainId/verify', async (request) => {
    requirePlatformAdmin(request);
    const { domainId } = domainParam.parse(request.params);
    return verifyDomain(domainId);
  });

  app.post('/api/platform/domains/:domainId/primary', async (request) => {
    requirePlatformAdmin(request);
    const { domainId } = domainParam.parse(request.params);
    return { domain: await setPrimaryDomain(domainId) };
  });

  app.post('/api/platform/domains/:domainId/disable', async (request) => {
    requirePlatformAdmin(request);
    const { domainId } = domainParam.parse(request.params);
    return { domain: await disableDomain(domainId) };
  });

  app.delete('/api/platform/domains/:domainId', async (request, reply) => {
    requirePlatformAdmin(request);
    const { domainId } = domainParam.parse(request.params);
    await deleteDomain(domainId);
    return reply.status(204).send();
  });

  /**
   * Consulted by the edge proxy before it requests a certificate for a hostname it has never
   * seen. 200 means "issue one"; anything else means "refuse". Without this gate anyone could
   * point a DNS name at the server and exhaust the certificate authority's rate limits.
   * Never forwarded by the public proxies; reachable only on the internal network.
   */
  app.get(
    '/api/internal/domain-allowed',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { domain } = z.object({ domain: z.string().max(300) }).parse(request.query);
      const hostname = normalizeHostname(domain);
      const allowed = hostname ? await isDomainApprovedForCertificate(hostname) : false;
      return reply.status(allowed ? 200 : 404).send({ allowed });
    },
  );
}

async function assertBusinessUnit(id: string): Promise<void> {
  const [row] = await withPlatformScope((tx) =>
    tx.select({ id: businessUnits.id }).from(businessUnits).where(eq(businessUnits.id, id)).limit(1),
  );
  if (!row) throw notFound('Business unit not found');
}
