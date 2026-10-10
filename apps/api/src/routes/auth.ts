import type { FastifyInstance } from 'fastify';
import { eq, ne } from 'drizzle-orm';
import { devLoginSchema, MEMBERSHIP_ROLES, ROLE_LABELS } from '@nio/shared';
import { authProvider, devAuthProvider } from '../auth/index.js';
import { requireActor, sessionMemberships, type Actor } from '../auth/context.js';
import { withPlatformScope } from '../db/client.js';
import { businessUnits, platformAdmins, users } from '../db/schema.js';
import { env } from '../env.js';
import { forbidden, notFound } from '../lib/errors.js';

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/config', async () => ({
    ...authProvider().publicConfig(),
    simulationEnabled: env.SIMULATION_ENABLED,
  }));

  /**
   * Dev-only shortcut that mints a token for an already-provisioned account. It cannot create
   * accounts, so the alpha table still gates who can reach the platform admin surface.
   */
  app.post(
    '/api/auth/dev/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const dev = devAuthProvider();
      if (!dev) throw forbidden('Dev login is disabled when AUTH_PROVIDER=auth0');

      const { email } = devLoginSchema.parse(request.body);

      const known = await withPlatformScope(async (tx) => {
        const [admin] = await tx
          .select({ email: platformAdmins.email, name: platformAdmins.name })
          .from(platformAdmins)
          .where(eq(platformAdmins.email, email))
          .limit(1);
        if (admin) return { email: admin.email, name: admin.name ?? admin.email };

        const [user] = await tx
          .select({ email: users.email, name: users.name })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        return user ?? null;
      });

      if (!known) throw notFound('No account exists for that email');

      const token = await dev.issueToken({
        provider: 'dev',
        subject: `dev|${known.email}`,
        email: known.email,
        name: known.name,
      });

      return { accessToken: token, tokenType: 'Bearer' };
    },
  );

  app.get('/api/auth/me', async (request) => {
    const actor = requireActor(request);
    const activeOrganizationId = actor.identity.orgId ?? null;
    const memberships = sessionMemberships(actor);

    return {
      email: actor.email,
      name: actor.name,
      userId: actor.userId,
      isPlatformAdmin: actor.isPlatformAdmin,
      provider: actor.identity.provider,
      activeOrganizationId,
      memberships,
      availableMemberships: actor.memberships,
      accessIssues: accessIssues(actor, memberships.length),
    };
  });

  /**
   * Everywhere the caller can work. Members see their own memberships; a platform admin sees every
   * business unit with every role, entered through the audited act-as header.
   */
  app.get('/api/workspaces', async (request) => {
    const actor = requireActor(request);
    const own = actor.memberships.map((membership) => ({ ...membership, actAs: false }));
    if (!actor.isPlatformAdmin) return { workspaces: own };

    const all = await withPlatformScope((tx) =>
      tx
        .select({
          businessUnitId: businessUnits.id,
          businessUnitSlug: businessUnits.slug,
          businessUnitName: businessUnits.name,
          auth0OrgId: businessUnits.auth0OrgId,
          businessUnitStatus: businessUnits.status,
        })
        .from(businessUnits)
        .where(ne(businessUnits.status, 'removed'))
        .orderBy(businessUnits.name),
    );
    return {
      workspaces: all.flatMap((businessUnit) =>
        MEMBERSHIP_ROLES.map((role) => ({ ...businessUnit, role, actAs: true })),
      ),
    };
  });
}

type AccessIssue =
  | { code: 'no_account'; message: string }
  | { code: 'account_inactive'; message: string }
  | { code: 'membership_suspended'; message: string }
  | { code: 'business_unit_inactive'; message: string }
  | { code: 'organization_required'; message: string };

/** Plain-language reasons a signed-in person might not reach a workspace. */
function accessIssues(actor: Actor, sessionMembershipCount: number): AccessIssue[] {
  const issues: AccessIssue[] = [];
  if (!actor.isPlatformAdmin && actor.userStatus === null) {
    issues.push({
      code: 'no_account',
      message: `No Qinio account is linked to ${actor.email}. Ask your business unit admin to add you, then use the sign-in link from the invitation.`,
    });
  }
  if (actor.userStatus && actor.userStatus !== 'active') {
    issues.push({
      code: 'account_inactive',
      message: `Your Qinio account is ${actor.userStatus}. Contact your business unit admin.`,
    });
  }
  for (const membership of actor.suspendedMemberships) {
    issues.push({
      code: 'membership_suspended',
      message: `Your ${ROLE_LABELS[membership.role]} access to ${membership.businessUnitName} is suspended.`,
    });
  }
  for (const membership of actor.memberships) {
    if (membership.businessUnitStatus !== 'active') {
      issues.push({
        code: 'business_unit_inactive',
        message: `${membership.businessUnitName} is ${membership.businessUnitStatus}.`,
      });
    }
  }
  if (
    actor.identity.provider === 'auth0' &&
    !actor.identity.orgId &&
    actor.memberships.length > 0 &&
    sessionMembershipCount === 0
  ) {
    issues.push({
      code: 'organization_required',
      message: 'Choose a business unit to continue; signing in to it happens automatically.',
    });
  }
  return issues;
}
