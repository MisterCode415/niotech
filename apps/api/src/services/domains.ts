import { randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import { and, asc, eq, ne } from 'drizzle-orm';
import { verificationRecordName, verificationRecordValue } from '@nio/shared';
import { authProvider } from '../auth/index.js';
import { withPlatformScope } from '../db/client.js';
import { businessUnitDomains } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import {
  clearHostCache,
  isPlatformHostname,
  platformHostname,
  resolveHost,
} from '../lib/hostTenant.js';
import { describeError } from '../lib/logSafe.js';

/** DNS lookups, behind an object so tests can substitute answers without touching the network. */
export const dnsClient = {
  resolveTxt: (name: string) => dns.resolveTxt(name),
  resolveCname: (name: string) => dns.resolveCname(name),
  resolve4: (name: string) => dns.resolve4(name),
};

export type DomainRow = typeof businessUnitDomains.$inferSelect;

export interface DomainView {
  id: string;
  hostname: string;
  status: DomainRow['status'];
  isPrimary: boolean;
  verifiedAt: Date | null;
  lastCheckAt: Date | null;
  lastCheckError: string | null;
  createdAt: Date;
  /** Records the tenant has to publish. */
  dns: {
    txtName: string;
    txtValue: string;
    /** Point the hostname here (CNAME for subdomains, ALIAS/ANAME for an apex). */
    target: string;
  };
}

export function toDomainView(row: DomainRow): DomainView {
  return {
    id: row.id,
    hostname: row.hostname,
    status: row.status,
    isPrimary: row.isPrimary,
    verifiedAt: row.verifiedAt,
    lastCheckAt: row.lastCheckAt,
    lastCheckError: row.lastCheckError,
    createdAt: row.createdAt,
    dns: {
      txtName: verificationRecordName(row.hostname),
      txtValue: verificationRecordValue(row.verificationToken),
      target: platformHostname(),
    },
  };
}

export async function listDomains(businessUnitId: string): Promise<DomainView[]> {
  const rows = await withPlatformScope((tx) =>
    tx
      .select()
      .from(businessUnitDomains)
      .where(eq(businessUnitDomains.businessUnitId, businessUnitId))
      .orderBy(asc(businessUnitDomains.createdAt)),
  );
  return rows.map(toDomainView);
}

async function loadDomain(id: string): Promise<DomainRow> {
  const [row] = await withPlatformScope((tx) =>
    tx.select().from(businessUnitDomains).where(eq(businessUnitDomains.id, id)).limit(1),
  );
  if (!row) throw notFound('Domain not found');
  return row;
}

export async function addDomain(businessUnitId: string, hostname: string): Promise<DomainView> {
  if (isPlatformHostname(hostname)) {
    throw badRequest('That hostname belongs to the platform and cannot be used as a custom domain');
  }

  try {
    const [row] = await withPlatformScope((tx) =>
      tx
        .insert(businessUnitDomains)
        .values({
          businessUnitId,
          hostname,
          verificationToken: randomBytes(18).toString('base64url'),
        })
        .returning(),
    );
    return toDomainView(row!);
  } catch (error) {
    // drizzle wraps the driver error, so the SQLSTATE may sit on `cause`.
    const code =
      (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') {
      throw conflict('That hostname is already registered', 'DOMAIN_TAKEN');
    }
    throw error;
  }
}

export interface DomainCheck {
  verified: boolean;
  error: string | null;
  /** Whether the hostname already resolves to the platform; informational, not required. */
  routed: boolean;
}

/** Proof of control is the TXT record; routing is checked only so the UI can warn about it. */
export async function checkDomainDns(row: DomainRow): Promise<DomainCheck> {
  const expected = verificationRecordValue(row.verificationToken);
  let verified = false;
  let error: string | null = null;

  try {
    const records = await dnsClient.resolveTxt(verificationRecordName(row.hostname));
    // A long TXT value is split into chunks by the resolver; rejoin each record before comparing.
    verified = records.some((chunks) => chunks.join('').trim() === expected);
    if (!verified) error = `TXT record at ${verificationRecordName(row.hostname)} does not contain the expected value`;
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    error =
      code === 'ENOTFOUND' || code === 'ENODATA'
        ? `No TXT record found at ${verificationRecordName(row.hostname)}`
        : `DNS lookup failed (${code ?? 'unknown'})`;
  }

  return { verified, error, routed: await pointsAtPlatform(row.hostname) };
}

async function pointsAtPlatform(hostname: string): Promise<boolean> {
  const target = platformHostname();
  try {
    const cnames = await dnsClient.resolveCname(hostname);
    if (cnames.some((name) => name.toLowerCase().replace(/\.$/, '') === target)) return true;
  } catch {
    // Apex domains cannot hold a CNAME; compare addresses below.
  }
  try {
    const [mine, theirs] = await Promise.all([
      dnsClient.resolve4(target),
      dnsClient.resolve4(hostname),
    ]);
    return theirs.some((address) => mine.includes(address));
  } catch {
    return false;
  }
}

export interface VerifyResult {
  domain: DomainView;
  check: DomainCheck;
  /** Set when the identity provider could not be updated; login from this domain will not work. */
  identityProviderError: string | null;
}

/**
 * Checks DNS and, on success, activates the domain. Also the way a disabled domain is re-enabled:
 * it must prove control again.
 */
export async function verifyDomain(id: string): Promise<VerifyResult> {
  const row = await loadDomain(id);
  const check = await checkDomainDns(row);
  const now = new Date();

  if (!check.verified) {
    const [updated] = await withPlatformScope((tx) =>
      tx
        .update(businessUnitDomains)
        .set({ lastCheckAt: now, lastCheckError: check.error, updatedAt: now })
        .where(eq(businessUnitDomains.id, id))
        .returning(),
    );
    return { domain: toDomainView(updated!), check, identityProviderError: null };
  }

  const updated = await withPlatformScope(async (tx) => {
    const [primary] = await tx
      .select({ id: businessUnitDomains.id })
      .from(businessUnitDomains)
      .where(
        and(
          eq(businessUnitDomains.businessUnitId, row.businessUnitId),
          eq(businessUnitDomains.isPrimary, true),
        ),
      )
      .limit(1);

    const [next] = await tx
      .update(businessUnitDomains)
      .set({
        status: 'verified',
        verifiedAt: row.verifiedAt ?? now,
        lastCheckAt: now,
        lastCheckError: null,
        // The first domain to verify becomes the one emails and QR codes point at.
        isPrimary: row.isPrimary || !primary,
        updatedAt: now,
      })
      .where(eq(businessUnitDomains.id, id))
      .returning();
    return next!;
  });
  clearHostCache();

  let identityProviderError: string | null = null;
  try {
    await authProvider().registerAppOrigin(`https://${row.hostname}`);
  } catch (error) {
    identityProviderError = 'Could not register this domain with the identity provider';
    console.error('Auth origin registration failed', describeError(error));
  }

  return { domain: toDomainView(updated), check, identityProviderError };
}

/** Makes a verified domain the one used in emails, QR stickers, and other request-less links. */
export async function setPrimaryDomain(id: string): Promise<DomainView> {
  const row = await loadDomain(id);
  if (row.status !== 'verified') throw badRequest('Only a verified domain can be primary');

  const updated = await withPlatformScope(async (tx) => {
    await tx
      .update(businessUnitDomains)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(businessUnitDomains.businessUnitId, row.businessUnitId),
          ne(businessUnitDomains.id, id),
          eq(businessUnitDomains.isPrimary, true),
        ),
      );
    const [next] = await tx
      .update(businessUnitDomains)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(businessUnitDomains.id, id))
      .returning();
    return next!;
  });
  clearHostCache();
  return toDomainView(updated);
}

/** Stops serving a domain and stops trusting it for login, without forgetting it. */
export async function disableDomain(id: string): Promise<DomainView> {
  const row = await loadDomain(id);

  const updated = await withPlatformScope(async (tx) => {
    const [next] = await tx
      .update(businessUnitDomains)
      .set({ status: 'disabled', isPrimary: false, updatedAt: new Date() })
      .where(eq(businessUnitDomains.id, id))
      .returning();

    if (row.isPrimary) await promoteReplacementPrimary(tx, row.businessUnitId);
    return next!;
  });
  clearHostCache();
  await unregisterOrigin(row.hostname);
  return toDomainView(updated);
}

export async function deleteDomain(id: string): Promise<void> {
  const row = await loadDomain(id);

  await withPlatformScope(async (tx) => {
    await tx.delete(businessUnitDomains).where(eq(businessUnitDomains.id, id));
    if (row.isPrimary) await promoteReplacementPrimary(tx, row.businessUnitId);
  });
  clearHostCache();
  await unregisterOrigin(row.hostname);
}

type PlatformTx = Parameters<Parameters<typeof withPlatformScope>[0]>[0];

async function promoteReplacementPrimary(tx: PlatformTx, businessUnitId: string): Promise<void> {
  const [replacement] = await tx
    .select({ id: businessUnitDomains.id })
    .from(businessUnitDomains)
    .where(
      and(
        eq(businessUnitDomains.businessUnitId, businessUnitId),
        eq(businessUnitDomains.status, 'verified'),
      ),
    )
    .orderBy(asc(businessUnitDomains.createdAt))
    .limit(1);
  if (replacement) {
    await tx
      .update(businessUnitDomains)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(businessUnitDomains.id, replacement.id));
  }
}

async function unregisterOrigin(hostname: string): Promise<void> {
  try {
    await authProvider().unregisterAppOrigin(`https://${hostname}`);
  } catch (error) {
    // The domain already stopped resolving; a stale allow-list entry is harmless and retryable.
    console.error('Auth origin removal failed', describeError(error));
  }
}

/** Gate for on-demand TLS: a certificate is only ever issued for a verified, active tenant domain. */
export async function isDomainApprovedForCertificate(hostname: string): Promise<boolean> {
  return (await resolveHost(hostname.trim().toLowerCase())).kind === 'tenant';
}
