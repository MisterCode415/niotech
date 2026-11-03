import { eq } from 'drizzle-orm';
import { withPlatformScope } from '../db/client.js';
import { businessUnits } from '../db/schema.js';

/**
 * The catalog widget (`/embed.js`) runs in a visitor's browser on a tenant's marketing site, so
 * the two calls it makes are cross-origin. They are the only routes that ever answer to a tenant
 * origin, and only to that tenant's own registered origins.
 */
const EMBED_ROUTE = /^\/api\/public\/([^/]+)\/(packages|checkout-intents)$/;

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; origins: string[] }>();

export function clearEmbedCorsCache(): void {
  cache.clear();
}

async function originsFor(slug: string): Promise<string[]> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.origins;

  const [row] = await withPlatformScope((tx) =>
    tx
      .select({ origins: businessUnits.marketingOrigins })
      .from(businessUnits)
      .where(eq(businessUnits.slug, slug))
      .limit(1),
  );
  const origins = row?.origins ?? [];
  // Slugs come from the URL, so unknown ones must not be able to grow the cache without bound.
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(slug, { at: Date.now(), origins });
  return origins;
}

/**
 * The single origin that may call this embed route, or null. The request's own `Origin` is only
 * ever echoed back when it exactly matches an entry the tenant registered.
 */
export async function embedOriginFor(
  url: string,
  requestOrigin: string | undefined,
): Promise<string | null> {
  if (!requestOrigin) return null;
  const match = EMBED_ROUTE.exec(url.split('?')[0] ?? '');
  if (!match) return null;

  let slug: string;
  try {
    slug = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return (await originsFor(slug)).includes(requestOrigin) ? requestOrigin : null;
}
