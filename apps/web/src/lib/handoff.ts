import { normalizeOrigin, type CheckoutAttribution } from '@nio/shared';

/**
 * State carried from a tenant's marketing site through checkout. It holds campaign tags, an intent
 * id, and a return link the API already validated, and nothing about the shopper or the order. It
 * lives in sessionStorage so it dies with the tab and is never shared across tabs.
 */
export interface Handoff {
  packageId: string;
  intentId?: string;
  /** Always taken from the API's response, never from the address bar. */
  returnUrl?: string;
  attribution: CheckoutAttribution;
}

const ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
] as const;

const keyFor = (slug: string) => `qinio.handoff.${slug}`;

/** Only the known campaign tags are read from the URL; anything else is ignored. */
export function attributionFromParams(params: URLSearchParams): CheckoutAttribution {
  const result: CheckoutAttribution = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = params.get(key)?.trim();
    if (value) result[key] = value.slice(0, 200);
  }
  return result;
}

export function saveHandoff(slug: string, handoff: Handoff): void {
  try {
    sessionStorage.setItem(keyFor(slug), JSON.stringify(handoff));
  } catch {
    // Storage unavailable: checkout still works, it just loses attribution and the back link.
  }
}

export function readHandoff(slug: string, packageId?: string): Handoff | null {
  try {
    const raw = sessionStorage.getItem(keyFor(slug));
    if (!raw) return null;
    const handoff = JSON.parse(raw) as Handoff;
    if (packageId && handoff.packageId !== packageId) return null;
    return handoff;
  } catch {
    return null;
  }
}

export function clearHandoff(slug: string): void {
  try {
    sessionStorage.removeItem(keyFor(slug));
  } catch {
    // Nothing to clear.
  }
}

/** A return link is shown only if it is still a plain http(s) URL with no credentials. */
export function safeReturnLink(url: string | undefined): { href: string; host: string } | null {
  if (!url || !normalizeOrigin(url)) return null;
  return { href: url, host: new URL(url).host };
}
