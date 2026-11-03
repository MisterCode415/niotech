import { and, eq, sql } from 'drizzle-orm';
import { workspacePath } from '@nio/shared';
import { authProvider } from '../auth/index.js';
import { withPlatformScope } from '../db/client.js';
import { memberships, users } from '../db/schema.js';
import { badRequest, conflict } from '../lib/errors.js';
import { tenantOrigin } from '../lib/hostTenant.js';
import { sendInvitationEmail } from './notifications.js';

export interface PatientBusinessUnit {
  id: string;
  slug: string;
  name: string;
  auth0OrgId: string | null;
}

export interface EnsurePatientInput {
  businessUnit: PatientBusinessUnit;
  email: string;
  name: string;
  /**
   * `now` provisions the identity-provider account and emails the activation link immediately.
   * `deferred` only reserves the roster entry; the invite is sent later, once something has
   * proven the shopper is real (see `sendOrderActivationInvites`).
   */
  invite: 'now' | 'deferred';
  /** In-app destination after sign-in. Only used when inviting. */
  returnTo?: string;
  /** Origin the invitation points at. Defaults to the tenant's primary domain, else the platform. */
  origin?: string;
  /** Overwrite the stored display name when the user already exists. Never for anonymous callers. */
  rename?: boolean;
  /** Re-activate a user row that is not currently active. Trusted server-to-server callers only. */
  reactivate?: boolean;
}

/**
 * The single place a patient joins a business unit's roster: user row, identity binding, and the
 * patient membership. Public registration, the purchase-ingestion API, and guest checkout all
 * come through here so they cannot drift apart on identity rules.
 */
export async function ensurePatient(input: EnsurePatientInput) {
  const { businessUnit } = input;
  const rename = input.rename ?? true;

  let subject: string | null = null;
  if (input.invite === 'now') {
    const returnTo = input.returnTo ?? workspacePath(businessUnit.slug, 'patient');
    const invited = await authProvider().inviteUser({
      orgId: businessUnit.auth0OrgId,
      email: input.email,
      name: input.name,
      loginPath:
        `/login?org=${encodeURIComponent(businessUnit.slug)}` +
        `&returnTo=${encodeURIComponent(returnTo)}`,
      origin: input.origin ?? (await tenantOrigin(businessUnit.id)),
    });
    subject = invited.subject;

    /*
     * Always send the result to the asserted address. Existing users receive a membership/sign-in
     * notice; new users receive activation. Whoever typed the address learns nothing either way.
     */
    if (invited.signInUrl) {
      await sendInvitationEmail({
        email: input.email,
        name: input.name,
        passwordSetUrl: invited.passwordSetUrl,
        signInUrl: invited.signInUrl,
        workspaceName: businessUnit.name,
        roleLabel: 'Patient',
      });
    }
  }

  return withPlatformScope(async (tx) => {
    let user: typeof users.$inferSelect;

    if (subject) {
      const [row] = await tx
        .insert(users)
        .values({
          email: input.email,
          name: input.name,
          auth0UserId: subject,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: users.email,
          set: {
            ...(rename ? { name: input.name } : {}),
            ...(input.reactivate ? { status: 'active' as const } : {}),
            // Adopt the identity for a row reserved by guest checkout, but never replace one.
            auth0UserId: sql`coalesce(${users.auth0UserId}, ${subject})`,
          },
        })
        .returning();
      user = row!;
      if (user.auth0UserId !== subject) {
        throw conflict('That email is already bound to a different identity');
      }
    } else {
      const [inserted] = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, auth0UserId: null, status: 'active' })
        .onConflictDoNothing({ target: users.email })
        .returning();
      const found =
        inserted ??
        (await tx.select().from(users).where(eq(users.email, input.email)).limit(1))[0];
      // One message for every refusal: the caller is anonymous and must not learn account state.
      if (!found || found.status !== 'active') {
        throw badRequest('Checkout is not available for this email');
      }
      user = found;
    }

    const [existing] = await tx
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.businessUnitId, businessUnit.id),
          eq(memberships.role, 'patient'),
        ),
      )
      .limit(1);

    if (!existing) {
      await tx
        .insert(memberships)
        .values({ userId: user.id, businessUnitId: businessUnit.id, role: 'patient' });
    } else if (input.invite === 'deferred' && existing.status !== 'active') {
      throw badRequest('Checkout is not available for this email');
    }

    return user;
  });
}
