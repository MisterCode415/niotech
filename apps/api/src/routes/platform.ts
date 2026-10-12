import type { FastifyInstance } from 'fastify';
import { eq, sql, desc } from 'drizzle-orm';
import { z } from 'zod';
import {
  createBusinessUnitSchema,
  platformAiSettingsSchema,
  reorderLlmProvidersSchema,
  updateBusinessUnitStatusSchema,
  upsertLlmProviderSchema,
} from '@nio/shared';
import { requirePlatformAdmin } from '../auth/context.js';
import { authProvider } from '../auth/index.js';
import { withPlatformScope } from '../db/client.js';
import {
  businessUnits,
  memberships,
  orders,
  platformAiSettings,
  platformLlmProviders,
  users,
} from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { decryptSecret, encryptSecret, maskSecret } from '../lib/secrets.js';
import { sendInvitationEmail } from '../services/notifications.js';
import { loadPlatformAiSettings } from '../services/reportChat.js';

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
      loginPath: `/login?org=${encodeURIComponent(input.slug)}`,
    });

    if (invited.signInUrl) {
      await sendInvitationEmail({
        email: input.adminEmail,
        name: input.adminName,
        passwordSetUrl: invited.passwordSetUrl,
        signInUrl: invited.signInUrl,
        workspaceName: input.name,
        roleLabel: 'Business Unit Admin',
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
          set: { name: input.adminName },
        })
        .returning();

      if (user!.auth0UserId !== invited.subject) {
        throw conflict('That email is already bound to a different identity');
      }

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

  app.get('/api/platform/ai', async (request) => {
    requirePlatformAdmin(request);
    return withPlatformScope(async (tx) => {
      const settings = await loadPlatformAiSettings(tx);
      const providers = await tx.select().from(platformLlmProviders).orderBy(platformLlmProviders.sortOrder);
      return {
        settings: { railsPrompt: settings.railsPrompt, disclaimer: settings.disclaimer },
        providers: providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          apiUrl: provider.apiUrl,
          apiKeyMasked: maskSecret(decryptSecret(provider.apiKeyCiphertext)),
          hasApiKey: Boolean(provider.apiKeyCiphertext),
          model: provider.model,
          customHeaders: provider.customHeaders,
          inputTokenCostPerMillion: Number(provider.inputTokenCostPerMillion),
          outputTokenCostPerMillion: Number(provider.outputTokenCostPerMillion),
          maxOutputTokens: provider.maxOutputTokens,
          sortOrder: provider.sortOrder,
          enabled: provider.enabled,
        })),
      };
    });
  });

  app.put('/api/platform/ai/settings', async (request) => {
    requirePlatformAdmin(request);
    const input = platformAiSettingsSchema.parse(request.body);
    return withPlatformScope(async (tx) => {
      const existing = await loadPlatformAiSettings(tx);
      const [settings] = await tx
        .update(platformAiSettings)
        .set({
          railsPrompt: input.railsPrompt,
          disclaimer: input.disclaimer,
          updatedAt: new Date(),
        })
        .where(eq(platformAiSettings.id, existing.id))
        .returning();
      return { settings };
    });
  });

  app.post('/api/platform/ai/providers', async (request, reply) => {
    requirePlatformAdmin(request);
    const input = upsertLlmProviderSchema.parse(request.body);
    const apiKey = input.apiKey?.trim();
    if (!apiKey) throw conflict('An API key is required', 'API_KEY_REQUIRED');
    const created = await withPlatformScope(async (tx) => {
      const existing = await tx.select({ sortOrder: platformLlmProviders.sortOrder }).from(platformLlmProviders);
      const sortOrder = input.sortOrder ?? (existing.length === 0 ? 0 : Math.max(...existing.map((r) => r.sortOrder)) + 1);
      const [row] = await tx
        .insert(platformLlmProviders)
        .values({
          name: input.name,
          apiUrl: input.apiUrl,
          apiKeyCiphertext: encryptSecret(apiKey),
          model: input.model,
          customHeaders: input.customHeaders,
          inputTokenCostPerMillion: String(input.inputTokenCostPerMillion),
          outputTokenCostPerMillion: String(input.outputTokenCostPerMillion),
          maxOutputTokens: input.maxOutputTokens,
          enabled: input.enabled,
          sortOrder,
        })
        .returning({ id: platformLlmProviders.id });
      return row;
    });
    return reply.status(201).send(created);
  });

  app.put('/api/platform/ai/providers/order', async (request) => {
    requirePlatformAdmin(request);
    const input = reorderLlmProvidersSchema.parse(request.body);
    await withPlatformScope(async (tx) => {
      for (const [index, id] of input.orderedIds.entries()) {
        await tx
          .update(platformLlmProviders)
          .set({ sortOrder: index, updatedAt: new Date() })
          .where(eq(platformLlmProviders.id, id));
      }
    });
    return { ok: true };
  });

  app.put('/api/platform/ai/providers/:id', async (request) => {
    requirePlatformAdmin(request);
    const { id } = idParam.parse(request.params);
    const input = upsertLlmProviderSchema.parse(request.body);
    return withPlatformScope(async (tx) => {
      const [existing] = await tx
        .select()
        .from(platformLlmProviders)
        .where(eq(platformLlmProviders.id, id))
        .limit(1);
      if (!existing) throw notFound('Provider not found');
      const [updated] = await tx
        .update(platformLlmProviders)
        .set({
          name: input.name,
          apiUrl: input.apiUrl,
          model: input.model,
          customHeaders: input.customHeaders,
          inputTokenCostPerMillion: String(input.inputTokenCostPerMillion),
          outputTokenCostPerMillion: String(input.outputTokenCostPerMillion),
          maxOutputTokens: input.maxOutputTokens,
          enabled: input.enabled,
          updatedAt: new Date(),
          ...(input.apiKey?.trim() ? { apiKeyCiphertext: encryptSecret(input.apiKey.trim()) } : {}),
        })
        .where(eq(platformLlmProviders.id, id))
        .returning({ id: platformLlmProviders.id });
      return updated;
    });
  });

  app.delete('/api/platform/ai/providers/:id', async (request) => {
    requirePlatformAdmin(request);
    const { id } = idParam.parse(request.params);
    const deleted = await withPlatformScope((tx) =>
      tx.delete(platformLlmProviders).where(eq(platformLlmProviders.id, id)).returning({ id: platformLlmProviders.id }),
    );
    if (deleted.length === 0) throw notFound('Provider not found');
    return { deleted: true };
  });
}
