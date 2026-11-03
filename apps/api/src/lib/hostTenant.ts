import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { BusinessUnitBrand } from '@nio/shared';
import { notFound } from './errors.js';
import { withPlatformScope } from '../db/client.js';
import { businessUnitDomains, businessUnits } from '../db/schema.js';
import { env } from '../env.js';

/**
 * What the request's Host header says about which tenant, if any, the caller is browsing as.
 *
 * - `platform`: the shared Qinio host (or any host we do not recognize); behaves exactly as before.
 * - `tenant`: a verified custom domain; the request is pinned to that one business unit.
 * - `inactive`: a registered domain that is pending, disabled, or whose tenant is suspended.
 */
export type HostResolution =
  | { kind: 'platform' }
  | {
      kind: 'tenant';
      hostname: string;
      businessUnitId: string;
      slug: string;
      name: string;
      brand: BusinessUnitBrand | null;
    }
  | { kind: 'inactive' };

const PLATFORM: HostResolution = { kind: 'platform' };
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 500;

const cache = new Map<string, { at: number; value: HostResolution }>();

/** The hostname part of a Host header: lowercase, no port, no trailing dot. */
export function requestHostname(header: string | undefined): string | null {
  if (!header) return null;
  let host = header.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(0, end + 1) : null;
  }
  const colon = host.indexOf(':');
  if (colon !== -1) host = host.slice(0, colon);
  host = host.replace(/\.$/, '');
  return host.length > 0 ? host : null;
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The platform's own hostnames. A custom domain may never claim any of these. */
export function platformHostnames(): Set<string> {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const origin of [env.WEB_ORIGIN, env.API_PUBLIC_URL]) {
    const host = hostOf(origin);
    if (host) hosts.add(host);
  }
  return hosts;
}

/** The hostname tenants point their CNAME at. */
export function platformHostname(): string {
  return hostOf(env.WEB_ORIGIN) ?? 'localhost';
}

export function isPlatformHostname(hostname: string): boolean {
  const platform = platformHostnames();
  if (platform.has(hostname)) return true;
  // `.localhost` is reserved for loopback (RFC 6761) and must never be claimable.
  if (hostname.endsWith('.localhost')) return true;
  // Subdomains of the platform host belong to the platform, not to tenants.
  const root = platformHostname();
  return root !== 'localhost' && hostname.endsWith(`.${root}`);
}

export function clearHostCache(): void {
  cache.clear();
}

async function lookup(hostname: string): Promise<HostResolution> {
  const [row] = await withPlatformScope((tx) =>
    tx
      .select({
        hostname: businessUnitDomains.hostname,
        domainStatus: businessUnitDomains.status,
        businessUnitId: businessUnits.id,
        slug: businessUnits.slug,
        name: businessUnits.name,
        brand: businessUnits.brand,
        buStatus: businessUnits.status,
      })
      .from(businessUnitDomains)
      .innerJoin(businessUnits, eq(businessUnits.id, businessUnitDomains.businessUnitId))
      .where(eq(businessUnitDomains.hostname, hostname))
      .limit(1),
  );
  if (!row) return PLATFORM;
  if (row.domainStatus !== 'verified' || row.buStatus !== 'active') return { kind: 'inactive' };
  return {
    kind: 'tenant',
    hostname: row.hostname,
    businessUnitId: row.businessUnitId,
    slug: row.slug,
    name: row.name,
    brand: row.brand ?? null,
  };
}

/**
 * Maps a request hostname to a tenant. Platform hostnames short-circuit without touching the
 * database, so the common path costs nothing. Results (including "unknown host") are cached
 * briefly; anything that changes a domain or brand calls {@link clearHostCache}.
 */
export async function resolveHost(hostname: string | null): Promise<HostResolution> {
  if (!hostname || platformHostnames().has(hostname)) return PLATFORM;

  const hit = cache.get(hostname);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const value = await lookup(hostname);
  // Bound memory: unknown hosts are attacker-controlled, so never let them grow the cache.
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(hostname, { at: Date.now(), value });
  return value;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `onRequest` host hook; `{ kind: 'platform' }` on the shared Qinio host. */
    hostTenant: HostResolution;
  }
}

/**
 * Runs first on every request. Resolves the host, pins custom-domain requests to their tenant,
 * and refuses anything addressed to an unverified or disabled domain.
 */
export async function enforceHost(request: FastifyRequest): Promise<void> {
  const resolution = await resolveHost(requestHostname(request.headers.host));
  request.hostTenant = resolution;

  if (resolution.kind === 'inactive') throw notFound('This address is not active');
  if (resolution.kind === 'tenant' && !customHostAllowsPath(request.url, resolution.slug)) {
    throw notFound();
  }
}

/**
 * The origin to put in links for a tenant when no request is available (emails, QR stickers):
 * its primary verified domain, else the shared platform origin.
 */
export async function tenantOrigin(businessUnitId: string): Promise<string> {
  const [primary] = await withPlatformScope((tx) =>
    tx
      .select({ hostname: businessUnitDomains.hostname })
      .from(businessUnitDomains)
      .where(
        and(
          eq(businessUnitDomains.businessUnitId, businessUnitId),
          eq(businessUnitDomains.status, 'verified'),
          eq(businessUnitDomains.isPrimary, true),
        ),
      )
      .limit(1),
  );
  return primary ? `https://${primary.hostname}` : env.WEB_ORIGIN;
}

/** The origin the caller is browsing from: their custom domain, or the shared platform origin. */
export function requestOrigin(request: FastifyRequest, businessUnitId: string): string {
  const host = request.hostTenant;
  if (host?.kind === 'tenant' && host.businessUnitId === businessUnitId) {
    return `https://${host.hostname}`;
  }
  return env.WEB_ORIGIN;
}

/** Route groups that carry no tenant of their own and are safe to serve on any custom host. */
const TENANT_NEUTRAL_PREFIXES = ['/api/health', '/api/auth', '/api/notifications', '/api/scan'];

/**
 * A custom domain serves exactly one tenant. Tenant-scoped routes must name that tenant; routes
 * that are inherently platform-wide (platform admin, workspace switcher, Stripe webhooks) are
 * refused so a tenant domain can never be used to reach them.
 */
export function customHostAllowsPath(url: string, slug: string): boolean {
  const path = url.split('?')[0] ?? '';

  const scoped = /^\/api\/(public|bu)\/([^/]+)(\/.*)?$/.exec(path);
  if (scoped) {
    const [, group, segment, rest] = scoped;
    if (group === 'public' && segment === 'host' && !rest) return true;
    try {
      return decodeURIComponent(segment!) === slug;
    } catch {
      return false;
    }
  }

  return TENANT_NEUTRAL_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}