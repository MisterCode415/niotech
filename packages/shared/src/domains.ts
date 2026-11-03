import { z } from 'zod';

export const DOMAIN_STATUSES = ['pending', 'verified', 'disabled'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

/** TXT value a tenant publishes at `_qinio.<hostname>` to prove they control the domain. */
export const DOMAIN_VERIFICATION_PREFIX = 'qinio-verify=';

export function verificationRecordName(hostname: string): string {
  return `_qinio.${hostname}`;
}

export function verificationRecordValue(token: string): string {
  return `${DOMAIN_VERIFICATION_PREFIX}${token}`;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A bare, lowercase DNS hostname, or null. URLs, ports, paths, IP addresses, single-label names,
 * and underscores are all rejected: whatever passes here ends up in a TLS certificate request.
 */
export function normalizeHostname(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  // The last label of a real domain is never purely numeric, which also excludes IPv4 literals.
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return host;
}

export const addDomainSchema = z.object({
  hostname: z
    .string()
    .max(300)
    .transform((value, ctx) => {
      const host = normalizeHostname(value);
      if (!host) {
        ctx.addIssue({
          code: 'custom',
          message: 'Enter a bare hostname such as order.your-clinic.com (no https://, path, or port)',
        });
        return z.NEVER;
      }
      return host;
    }),
});
export type AddDomainInput = z.infer<typeof addDomainSchema>;

export interface BusinessUnitBrand {
  displayName?: string;
  logoUrl?: string;
  /** `#rrggbb`; drives buttons, links, and highlights. */
  primaryColor?: string;
}

export const businessUnitBrandSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  logoUrl: z
    .url()
    .max(500)
    .refine((value) => value.startsWith('https://'), 'Logo URL must use https')
    .optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color such as #2563eb')
    .optional(),
});
