import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  createMemberSchema,
  createPackageSchema,
  createTestTypeSchema,
  upsertMarketingPageSchema,
} from '@nio/shared';
import { requireMembership } from '../auth/context.js';
import { authProvider } from '../auth/index.js';
import { withPlatformScope, withTenant } from '../db/client.js';
import {
  businessUnits,
  marketingPages,
  memberships,
  orders,
  packageTestTypes,
  packages,
  testTypes,
  users,
} from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';

const slugParam = z.object({ slug: z.string() });

export async function businessUnitRoutes(app: FastifyInstance) {
  app.get('/api/bu/:slug/summary', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);

    return withTenant(ctx.businessUnitId, async (tx) => {
      const [counts] = await tx
        .select({
          totalOrders: sql<number>`count(*)::int`,
          awaitingReview: sql<number>`count(*) filter (where ${orders.status} = 'awaiting_clinician_review')::int`,
          released: sql<number>`count(*) filter (where ${orders.status} = 'results_released')::int`,
        })
        .from(orders);

      const roster = await tx
        .select({ role: memberships.role, count: sql<number>`count(*)::int` })
        .from(memberships)
        .groupBy(memberships.role);

      return {
        businessUnit: { id: ctx.businessUnitId, slug: ctx.businessUnitSlug },
        orders: counts ?? { totalOrders: 0, awaitingReview: 0, released: 0 },
        roster,
      };
    });
  });

  /* ------------------------------- Marketing page ------------------------------- */

  app.get('/api/bu/:slug/marketing-page', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);

    return withTenant(ctx.businessUnitId, async (tx) => {
      const versions = await tx
        .select()
        .from(marketingPages)
        .orderBy(desc(marketingPages.version))
        .limit(20);
      return { versions, published: versions.find((v) => v.isPublished) ?? null };
    });
  });

  /** Each save is a new immutable version, so publishing is a pointer move and never a rewrite. */
  app.put('/api/bu/:slug/marketing-page', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    const input = upsertMarketingPageSchema.parse(request.body);

    return withTenant(ctx.businessUnitId, async (tx) => {
      const [latest] = await tx
        .select({ version: marketingPages.version })
        .from(marketingPages)
        .orderBy(desc(marketingPages.version))
        .limit(1);

      const nextVersion = (latest?.version ?? 0) + 1;

      if (input.publish) {
        await tx.update(marketingPages).set({ isPublished: false });
      }

      const [page] = await tx
        .insert(marketingPages)
        .values({
          businessUnitId: ctx.businessUnitId,
          version: nextVersion,
          title: input.title,
          headline: input.headline,
          bodyHtml: input.bodyHtml,
          isPublished: input.publish,
        })
        .returning();

      return { page };
    });
  });

  /* --------------------------------- Test types --------------------------------- */

  app.get('/api/bu/:slug/test-types', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin', 'lab']);

    return withTenant(ctx.businessUnitId, async (tx) => ({
      testTypes: await tx.select().from(testTypes).orderBy(testTypes.name),
    }));
  });

  app.post('/api/bu/:slug/test-types', async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    const input = createTestTypeSchema.parse(request.body);

    const result = await withTenant(ctx.businessUnitId, async (tx) => {
      const [row] = await tx
        .insert(testTypes)
        .values({ ...input, businessUnitId: ctx.businessUnitId })
        .returning();
      return row;
    });

    return reply.status(201).send({ testType: result });
  });

  /* ---------------------------------- Packages ---------------------------------- */

  app.get('/api/bu/:slug/packages', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);

    return withTenant(ctx.businessUnitId, async (tx) => {
      const rows = await tx.select().from(packages).orderBy(packages.name);
      const tests = await tx
        .select({
          packageId: packageTestTypes.packageId,
          testTypeId: packageTestTypes.testTypeId,
          quantity: packageTestTypes.quantity,
          name: testTypes.name,
        })
        .from(packageTestTypes)
        .innerJoin(testTypes, eq(testTypes.id, packageTestTypes.testTypeId));

      return {
        packages: rows.map((pkg) => ({
          ...pkg,
          tests: tests.filter((t) => t.packageId === pkg.id),
        })),
      };
    });
  });

  app.post('/api/bu/:slug/packages', async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    const input = createPackageSchema.parse(request.body);

    const created = await withTenant(ctx.businessUnitId, async (tx) => {
      // RLS keeps this tenant-local, but check explicitly so the error is a clear 400.
      const owned = await tx.select({ id: testTypes.id }).from(testTypes);
      const ownedIds = new Set(owned.map((t) => t.id));
      for (const test of input.tests) {
        if (!ownedIds.has(test.testTypeId)) {
          throw badRequest(`Unknown test type ${test.testTypeId}`);
        }
      }

      const [pkg] = await tx
        .insert(packages)
        .values({
          businessUnitId: ctx.businessUnitId,
          name: input.name,
          description: input.description,
          focusArea: input.focusArea,
          priceCents: input.priceCents,
          requiresClinician: input.requiresClinician,
          status: 'active',
        })
        .returning();

      await tx.insert(packageTestTypes).values(
        input.tests.map((test) => ({
          packageId: pkg!.id,
          testTypeId: test.testTypeId,
          quantity: test.quantity,
        })),
      );

      return pkg;
    });

    return reply.status(201).send({ package: created });
  });

  app.patch('/api/bu/:slug/packages/:packageId/status', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const { packageId } = z.object({ packageId: z.uuid() }).parse(request.params);
    const { status } = z.object({ status: z.enum(['draft', 'active', 'archived']) }).parse(request.body);
    const ctx = requireMembership(request, slug, ['bu_admin']);

    const [updated] = await withTenant(ctx.businessUnitId, (tx) =>
      tx.update(packages).set({ status }).where(eq(packages.id, packageId)).returning(),
    );
    if (!updated) throw notFound('Package not found');
    return { package: updated };
  });

  /* ----------------------------------- Members ----------------------------------- */

  app.get('/api/bu/:slug/members', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);

    // `users` is a platform-wide table, so the join is scoped by the tenant-filtered memberships.
    const rows = await withTenant(ctx.businessUnitId, (tx) =>
      tx
        .select({
          membershipId: memberships.id,
          userId: users.id,
          email: users.email,
          name: users.name,
          role: memberships.role,
          status: memberships.status,
          createdAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .orderBy(memberships.role, users.name),
    );

    return { members: rows };
  });

  /** Creates the workflow accounts: fulfillment, lab, doctor, extra admins. */
  app.post('/api/bu/:slug/members', async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    const input = createMemberSchema.parse(request.body);

    const [businessUnit] = await withPlatformScope((tx) =>
      tx.select().from(businessUnits).where(eq(businessUnits.id, ctx.businessUnitId)).limit(1),
    );

    const invited = await authProvider().inviteUser({
      orgId: businessUnit?.auth0OrgId ?? null,
      email: input.email,
      name: input.name,
    });

    const member = await withPlatformScope(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          name: input.name,
          auth0UserId: invited.subject,
          status: 'active',
        })
        .onConflictDoUpdate({ target: users.email, set: { name: input.name } })
        .returning();

      const [membership] = await tx
        .insert(memberships)
        .values({ userId: user!.id, businessUnitId: ctx.businessUnitId, role: input.role })
        .onConflictDoUpdate({
          target: [memberships.userId, memberships.businessUnitId, memberships.role],
          set: { status: 'active' },
        })
        .returning();

      return { user: user!, membership: membership! };
    });

    return reply.status(201).send(member);
  });

  app.patch('/api/bu/:slug/members/:membershipId/status', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const { membershipId } = z.object({ membershipId: z.uuid() }).parse(request.params);
    const { status } = z.object({ status: z.enum(['active', 'suspended']) }).parse(request.body);
    const ctx = requireMembership(request, slug, ['bu_admin']);

    const [updated] = await withTenant(ctx.businessUnitId, (tx) =>
      tx
        .update(memberships)
        .set({ status })
        .where(and(eq(memberships.id, membershipId), eq(memberships.businessUnitId, ctx.businessUnitId)))
        .returning(),
    );

    if (!updated) throw notFound('Member not found');
    return { membership: updated };
  });

  /* ------------------------------- Orders overview ------------------------------- */

  app.get('/api/bu/:slug/orders', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);

    const rows = await withTenant(ctx.businessUnitId, (tx) =>
      tx
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          status: orders.status,
          createdAt: orders.createdAt,
          patientName: users.name,
          packageName: packages.name,
          requiresClinician: orders.requiresClinician,
        })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.patientUserId))
        .innerJoin(packages, eq(packages.id, orders.packageId))
        .orderBy(desc(orders.createdAt))
        .limit(200),
    );

    return { orders: rows };
  });
}
