import type { FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { MembershipRole, ActorRole, BusinessUnitStatus } from '@nio/shared';
import { withPlatformScope } from '../db/client.js';
import { businessUnits, memberships, platformAdmins, users } from '../db/schema.js';
import { unauthorized, forbidden, notFound } from '../lib/errors.js';
import { authProvider } from './index.js';
import type { AuthIdentity } from './provider.js';

export interface ActorMembership {
  businessUnitId: string;
  businessUnitSlug: string;
  businessUnitName: string;
  auth0OrgId: string | null;
  businessUnitStatus: BusinessUnitStatus;
  role: MembershipRole;
}

export interface Actor {
  identity: AuthIdentity;
  userId: string | null;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  memberships: ActorMembership[];
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

/**
 * Resolving who the caller is spans tenants by definition, so it runs in platform scope. It is
 * read-only and touches nothing but the identity tables.
 */
async function loadActor(identity: AuthIdentity): Promise<Actor> {
  return withPlatformScope(async (tx) => {
    let [admin] = await tx
      .select()
      .from(platformAdmins)
      .where(eq(platformAdmins.auth0UserId, identity.subject))
      .limit(1);

    if (!admin) {
      const [unboundAdmin] = await tx
        .select()
        .from(platformAdmins)
        .where(and(eq(platformAdmins.email, identity.email), isNull(platformAdmins.auth0UserId)))
        .limit(1);

      if (unboundAdmin) {
        [admin] = await tx
          .update(platformAdmins)
          .set({ auth0UserId: identity.subject })
          .where(and(eq(platformAdmins.id, unboundAdmin.id), isNull(platformAdmins.auth0UserId)))
          .returning();
      }
    }

    let [user] = await tx
      .select()
      .from(users)
      .where(eq(users.auth0UserId, identity.subject))
      .limit(1);

    if (!user) {
      const [unboundUser] = await tx
        .select()
        .from(users)
        .where(and(eq(users.email, identity.email), isNull(users.auth0UserId)))
        .limit(1);

      if (unboundUser) {
        [user] = await tx
          .update(users)
          .set({ auth0UserId: identity.subject })
          .where(and(eq(users.id, unboundUser.id), isNull(users.auth0UserId)))
          .returning();
      }
    }

    const rows = user?.status === 'active'
      ? await tx
          .select({
            businessUnitId: memberships.businessUnitId,
            role: memberships.role,
            membershipStatus: memberships.status,
            businessUnitSlug: businessUnits.slug,
            businessUnitName: businessUnits.name,
            auth0OrgId: businessUnits.auth0OrgId,
            businessUnitStatus: businessUnits.status,
          })
          .from(memberships)
          .innerJoin(businessUnits, eq(businessUnits.id, memberships.businessUnitId))
          .where(eq(memberships.userId, user.id))
      : [];

    return {
      identity,
      userId: user?.status === 'active' ? user.id : null,
      email: identity.email,
      name: user?.name ?? admin?.name ?? identity.name ?? identity.email,
      isPlatformAdmin: Boolean(admin?.isActive),
      memberships: rows
        .filter((r) => r.membershipStatus === 'active')
        .map((r) => ({
          businessUnitId: r.businessUnitId,
          businessUnitSlug: r.businessUnitSlug,
          businessUnitName: r.businessUnitName,
          auth0OrgId: r.auth0OrgId,
          businessUnitStatus: r.businessUnitStatus,
          role: r.role,
        })),
    };
  });
}

/** Attaches `request.actor` when a valid bearer token is present. Never rejects on its own. */
export async function attachActor(request: FastifyRequest): Promise<void> {
  request.actor = null;
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return;

  const identity = await authProvider().verifyToken(header.slice('Bearer '.length));
  request.actor = await loadActor(identity);
}

export function requireActor(request: FastifyRequest): Actor {
  if (!request.actor) throw unauthorized();
  return request.actor;
}

/** Memberships the current token may exercise; an Auth0 token is confined to its `org_id`. */
export function sessionMemberships(actor: Actor): ActorMembership[] {
  if (actor.identity.provider !== 'auth0') return actor.memberships;
  if (!actor.identity.orgId) return [];
  return actor.memberships.filter(
    (membership) => membership.auth0OrgId === actor.identity.orgId,
  );
}

export function requireOrganizationScope(actor: Actor, membership: ActorMembership): void {
  if (actor.identity.provider !== 'auth0') return;
  if (!actor.identity.orgId) {
    throw forbidden('Select this organization from the workspace chooser before continuing');
  }
  if (!membership.auth0OrgId || membership.auth0OrgId !== actor.identity.orgId) {
    throw forbidden('Your session is scoped to a different organization');
  }
}

export function requirePlatformAdmin(request: FastifyRequest): Actor {
  const actor = requireActor(request);
  if (!actor.isPlatformAdmin) throw forbidden('Platform administrator access required');
  if (actor.identity.provider === 'auth0' && actor.identity.orgId) {
    throw forbidden('Switch to the platform workspace before using platform administration');
  }
  return actor;
}

export interface TenantContext {
  actor: Actor;
  userId: string;
  businessUnitId: string;
  businessUnitSlug: string;
  role: MembershipRole;
  actorRole: ActorRole;
}

/**
 * Resolves the business unit named in the route and confirms the caller holds one of the
 * accepted roles inside it. A suspended business unit is closed to everyone but its admin.
 */
export function requireMembership(
  request: FastifyRequest,
  slug: string,
  acceptedRoles: readonly MembershipRole[],
): TenantContext {
  const actor = requireActor(request);
  const membership = actor.memberships.find(
    (m) => m.businessUnitSlug === slug && acceptedRoles.includes(m.role),
  );

  if (!membership) {
    // Do not leak whether the business unit exists to someone with no access to it.
    const belongsAtAll = actor.memberships.some((m) => m.businessUnitSlug === slug);
    throw belongsAtAll ? forbidden(`Requires role: ${acceptedRoles.join(' or ')}`) : notFound();
  }

  requireOrganizationScope(actor, membership);

  if (membership.businessUnitStatus !== 'active' && membership.role !== 'bu_admin') {
    throw forbidden('This business unit is not currently active');
  }

  if (!actor.userId) throw unauthorized();

  return {
    actor,
    userId: actor.userId,
    businessUnitId: membership.businessUnitId,
    businessUnitSlug: membership.businessUnitSlug,
    role: membership.role,
    actorRole: membership.role,
  };
}

/** Looks up an active business unit by slug without requiring a session (public marketing/catalog). */
export async function findPublicBusinessUnit(slug: string) {
  const [bu] = await withPlatformScope((tx) =>
    tx
      .select()
      .from(businessUnits)
      .where(and(eq(businessUnits.slug, slug), eq(businessUnits.status, 'active')))
      .limit(1),
  );
  if (!bu) throw notFound('Business unit not found');
  return bu;
}
