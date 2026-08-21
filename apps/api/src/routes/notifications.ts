import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requireActor } from '../auth/context.js';
import { withTenant } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { forbidden, notFound } from '../lib/errors.js';

export async function notificationRoutes(app: FastifyInstance) {
  /** The bell. A user can hold roles in several tenants, so this reads across their memberships. */
  app.get('/api/notifications', async (request) => {
    const actor = requireActor(request);
    if (!actor.userId) return { notifications: [], unreadCount: 0 };

    const perTenant = await Promise.all(
      actor.memberships.map((membership) =>
        withTenant(membership.businessUnitId, (tx) =>
          tx
            .select()
            .from(notifications)
            .where(eq(notifications.userId, actor.userId!))
            .orderBy(desc(notifications.createdAt))
            .limit(50),
        ).then((rows) =>
          rows.map((row) => ({ ...row, businessUnitSlug: membership.businessUnitSlug })),
        ),
      ),
    );

    const all = perTenant
      .flat()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 50);

    return { notifications: all, unreadCount: all.filter((n) => !n.readAt).length };
  });

  app.post('/api/notifications/:id/read', async (request) => {
    const actor = requireActor(request);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    if (!actor.userId) throw forbidden();

    for (const membership of actor.memberships) {
      const [updated] = await withTenant(membership.businessUnitId, (tx) =>
        tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(and(eq(notifications.id, id), eq(notifications.userId, actor.userId!)))
          .returning({ id: notifications.id }),
      );
      if (updated) return { id: updated.id, read: true };
    }

    throw notFound('Notification not found');
  });

  app.post('/api/notifications/read-all', async (request) => {
    const actor = requireActor(request);
    if (!actor.userId) throw forbidden();

    let updated = 0;
    for (const membership of actor.memberships) {
      const rows = await withTenant(membership.businessUnitId, (tx) =>
        tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(and(eq(notifications.userId, actor.userId!), isNull(notifications.readAt)))
          .returning({ id: notifications.id }),
      );
      updated += rows.length;
    }

    return { updated };
  });
}
