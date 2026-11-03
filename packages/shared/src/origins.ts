/**
 * Origin handling for the tenant marketing-site allowlist. A return link is only ever followed
 * when its origin was explicitly registered by the business unit, so these checks are deliberately
 * strict: https only (plain http solely for loopback development), no embedded credentials, and
 * comparison on the parsed origin rather than on a string prefix.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseWebUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

/** The canonical origin (`https://shop.example.com`) of a URL, or null if it is not acceptable. */
export function normalizeOrigin(value: string): string | null {
  const url = parseWebUrl(value);
  return url ? url.origin : null;
}

/** True when `value` is an acceptable absolute URL whose origin is on the allowlist. */
export function isAllowedReturnUrl(value: string, origins: readonly string[]): boolean {
  const url = parseWebUrl(value);
  if (!url) return false;
  return origins.includes(url.origin);
}
