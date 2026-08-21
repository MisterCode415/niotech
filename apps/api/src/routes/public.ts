import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { registerPatientSchema } from '@nio/shared';
import { findPublicBusinessUnit } from '../auth/context.js';
import { authProvider } from '../auth/index.js';
import { withPlatformScope, withTenant } from '../db/client.js';
import {
  businessUnits,
  marketingPages,
  memberships,
  packageTestTypes,
  packages,
  testTypes,
  users,
} from '../db/schema.js';

const slugParam = z.object({ slug: z.string() });

export async function publicRoutes(app: FastifyInstance) {
  /** Directory of active tenants; the storefront entry point during local development. */
  app.get('/api/public/business-units', async () => {
    const rows = await withPlatformScope((tx) =>
      tx
        .select({ name: businessUnits.name, slug: businessUnits.slug })
        .from(businessUnits)
        .where(eq(businessUnits.status, 'active'))
        .orderBy(businessUnits.name),
    );
    return { businessUnits: rows };
  });

  app.get('/api/public/:slug/page', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const businessUnit = await findPublicBusinessUnit(slug);

    const [page] = await withTenant(businessUnit.id, (tx) =>
      tx
        .select()
        .from(marketingPages)
        .where(eq(marketingPages.isPublished, true))
        .orderBy(desc(marketingPages.version))
        .limit(1),
    );

    return {
      businessUnit: { name: businessUnit.name, slug: businessUnit.slug },
      page: page ?? null,
    };
  });

  app.get('/api/public/:slug/packages', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const businessUnit = await findPublicBusinessUnit(slug);

    return withTenant(businessUnit.id, async (tx) => {
      const rows = await tx
        .select()
        .from(packages)
        .where(eq(packages.status, 'active'))
        .orderBy(packages.priceCents);

      const tests = await tx
        .select({
          packageId: packageTestTypes.packageId,
          quantity: packageTestTypes.quantity,
          name: testTypes.name,
          description: testTypes.description,
          sampleType: testTypes.sampleType,
          turnaroundDays: testTypes.turnaroundDays,
        })
        .from(packageTestTypes)
        .innerJoin(testTypes, eq(testTypes.id, packageTestTypes.testTypeId));

      return {
        businessUnit: { name: businessUnit.name, slug: businessUnit.slug },
        packages: rows.map((pkg) => ({
          ...pkg,
          tests: tests.filter((t) => t.packageId === pkg.id),
          kitCount: tests
            .filter((t) => t.packageId === pkg.id)
            .reduce((sum, t) => sum + t.quantity, 0),
        })),
      };
    });
  });

  /**
   * Patient self-registration. A patient is a member of one business unit's roster like any other
   * role, which is what keeps their orders and results inside that tenant.
   */
  app.post('/api/public/:slug/register', async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const businessUnit = await findPublicBusinessUnit(slug);
    const input = registerPatientSchema.parse(request.body);

    const invited = await authProvider().inviteUser({
      orgId: businessUnit.auth0OrgId,
      email: input.email,
      name: input.name,
    });

    const result = await withPlatformScope(async (tx) => {
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

      const [existing] = await tx
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, user!.id),
            eq(memberships.businessUnitId, businessUnit.id),
            eq(memberships.role, 'patient'),
          ),
        )
        .limit(1);

      if (!existing) {
        await tx
          .insert(memberships)
          .values({ userId: user!.id, businessUnitId: businessUnit.id, role: 'patient' });
      }

      return { userId: user!.id, email: user!.email, name: user!.name };
    });

    return reply.status(201).send(result);
  });
}
