import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { registerPatientSchema } from '@nio/shared';
import { findPublicBusinessUnit } from '../auth/context.js';
import { authProvider } from '../auth/index.js';
import { sendInvitationEmail } from '../services/notifications.js';
import { withPlatformScope, withTenant } from '../db/client.js';
import { conflict } from '../lib/errors.js';
import {
  marketingPages,
  memberships,
  packageTestTypes,
  packages,
  testTypes,
  users,
} from '../db/schema.js';

const slugParam = z.object({ slug: z.string() });

export async function publicRoutes(app: FastifyInstance) {
  /**
   * Login hand-off. Auth0 needs the organization at the moment it redirects, before anyone is
   * authenticated, so the mapping from a public slug to its organization has to be readable
   * anonymously. Organization ids are not secret — they travel as a query parameter on the hosted
   * login URL — and this exposes nothing that the storefront does not already publish.
   */
  app.get('/api/public/:slug/login', async (request) => {
    const { slug } = slugParam.parse(request.params);
    const businessUnit = await findPublicBusinessUnit(slug);
    return {
      businessUnit: { name: businessUnit.name, slug: businessUnit.slug },
      organization: businessUnit.auth0OrgId ?? null,
    };
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
  app.post(
    '/api/public/:slug/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const { slug } = slugParam.parse(request.params);
      const businessUnit = await findPublicBusinessUnit(slug);
      const input = registerPatientSchema.parse(request.body);

      const packageId = input.packageId;
      if (packageId) {
        const [available] = await withTenant(businessUnit.id, (tx) =>
          tx
            .select({ id: packages.id })
            .from(packages)
            .where(and(eq(packages.id, packageId), eq(packages.status, 'active')))
            .limit(1),
        );
        if (!available) throw conflict('Package is not available');
      }

      const returnTo = input.packageId
        ? `/${slug}/checkout/${input.packageId}`
        : '/portal/orders';
      const invited = await authProvider().inviteUser({
        orgId: businessUnit.auth0OrgId,
        email: input.email,
        name: input.name,
        loginPath:
          `/login?org=${encodeURIComponent(slug)}` +
          `&returnTo=${encodeURIComponent(returnTo)}`,
      });

      /*
       * Always send the result to the asserted address and return the same generic response.
       * Existing users receive a membership/sign-in notice; new users receive activation.
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

      await withPlatformScope(async (tx) => {
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

        if (user!.auth0UserId !== invited.subject) {
          throw conflict('That email is already bound to a different identity');
        }

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
      });

      return reply.status(202).send({ accepted: true });
    },
  );
}
