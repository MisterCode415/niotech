import type { FastifyInstance } from 'fastify';
import { eq, sql, desc } from 'drizzle-orm';
import { z } from 'zod';
import { createBusinessUnitSchema, updateBusinessUnitStatusSchema } from '@nio/shared';
import { requirePlatformAdmin } from '../auth/context.js';
import { authProvider } from '../auth/index.js';
import { withPlatformScope } from '../db/client.js';
import { businessUnits, memberships, orders, users } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { sendInvitationEmail } from '../services/notifications.js';

const idParam = z.object({ id: z.uuid() });

export async function platformRoutes(app: FastifyInstance) {
  app.get('/api/platform/business-units', async (request) => {
    requirePlatformAdmin(request);

    return withPlatformScope(async (tx) => {
      const rows = await tx
        .select({
          id: businessUnits.id,
          name: businessUnits.name,
          slug: businessUnits.slug,
          status: businessUnits.status,
          auth0OrgId: businessUnits.auth0OrgId,
          createdAt: businessUnits.createdAt,
          memberCount: sql<number>`(
            select count(*)::int from ${memberships} m where m.business_unit_id = ${businessUnits.id}
          )`,
          orderCount: sql<number>`(
            select count(*)::int from ${orders} o where o.business_unit_id = ${businessUnits.id}
          )`,
        })
        .from(businessUnits)
        .orderBy(desc(businessUnits.createdAt));

      return { businessUnits: rows };
    });
  });

  /**
   * Onboards a business unit and its first admin in one step. Everything after this - packages,
   * marketing, the rest of the role roster - is that admin's job, not the platform's.
   */
  app.post('/api/platform/business-units', async (request, reply) => {
    requirePlatformAdmin(request);
    const input = createBusinessUnitSchema.parse(request.body);

    const existing = await withPlatformScope((tx) =>
      tx.select({ id: businessUnits.id }).from(businessUnits).where(eq(businessUnits.slug, input.slug)).limit(1),
    );
    if (existing.length > 0) throw conflict(`Slug "${input.slug}" is already taken`, 'SLUG_TAKEN');

    const org = await authProvider().createOrganization({ name: input.name, slug: input.slug });
    const invited = await authProvider().inviteUser({
      orgId: org.orgId,
      email: input.adminEmail,
      name: input.adminName,
    });

    /*
     * Sent before the rows are written because the identity already exists and cannot be undone by
     * rolling back. Failing here leaves nothing half-onboarded, and a retry reissues the link.
     */
    if (invited.passwordSetUrl) {
      await sendInvitationEmail({
        email: input.adminEmail,
        name: input.adminName,
        url: invited.passwordSetUrl,
      });
    }

    const created = await withPlatformScope(async (tx) => {
      const [businessUnit] = await tx
        .insert(businessUnits)
        .values({ name: input.name, slug: input.slug, auth0OrgId: org.orgId, status: 'active' })
        .returning();

      const [user] = await tx
        .insert(users)
        .values({
          email: input.adminEmail,
          name: input.adminName,
          auth0UserId: invited.subject,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: users.email,
          set: { name: input.adminName, auth0UserId: invited.subject },
        })
        .returning();

      await tx
        .insert(memberships)
        .values({ userId: user!.id, businessUnitId: businessUnit!.id, role: 'bu_admin' })
        .onConflictDoNothing();

      return { businessUnit: businessUnit!, admin: user! };
    });

    return reply.status(201).send(created);
  });

  app.patch('/api/platform/business-units/:id/status', async (request) => {
    requirePlatformAdmin(request);
    const { id } = idParam.parse(request.params);
    const { status } = updateBusinessUnitStatusSchema.parse(request.body);

    const [updated] = await withPlatformScope((tx) =>
      tx
        .update(businessUnits)
        .set({ status, updatedAt: new Date() })
        .where(eq(businessUnits.id, id))
        .returning(),
    );

    if (!updated) throw notFound('Business unit not found');
    return { businessUnit: updated };
  });

  app.get('/api/platform/overview', async (request) => {
    requirePlatformAdmin(request);

    return withPlatformScope(async (tx) => {
      const [counts] = await tx
        .select({
          businessUnits: sql<number>`(select count(*)::int from ${businessUnits})`,
          activeBusinessUnits: sql<number>`(select count(*)::int from ${businessUnits} where status = 'active')`,
          users: sql<number>`(select count(*)::int from ${users})`,
          orders: sql<number>`(select count(*)::int from ${orders})`,
        })
        .from(sql`(select 1) as _`);

      return counts;
    });
  });
}
