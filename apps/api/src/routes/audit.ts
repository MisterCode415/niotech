import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, lte, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { requireMembership } from '../auth/context.js';
import { withTenant } from '../db/client.js';
import {
  orderEvents,
  orders,
  phiAccessEvents,
  reportConversations,
  users,
} from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { toCsv } from '../lib/csv.js';
import { recordPhiAccess } from '../services/phiAudit.js';

const slugParam = z.object({ slug: z.string() });

const querySchema = z
  .object({
    patientEmail: z.email().optional(),
    orderId: z.uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .refine((q) => q.patientEmail || q.orderId, {
    message: 'Provide a patientEmail or an orderId',
  });

/** Each source is capped so one broad request cannot pull an unbounded slice of the trail. */
const PER_SOURCE_LIMIT = 5000;

export interface DisclosureEntry extends Record<string, unknown> {
  at: Date;
  source: 'phi_access' | 'order_event' | 'conversation';
  orderId: string | null;
  actorEmail: string | null;
  actorRole: string;
  actingPlatformAdmin: boolean;
  resource: string;
  action: string;
  detail: string;
  requestId: string | null;
  ip: string | null;
}

const CSV_COLUMNS = [
  'at',
  'source',
  'orderId',
  'actorEmail',
  'actorRole',
  'actingPlatformAdmin',
  'resource',
  'action',
  'detail',
  'requestId',
  'ip',
] as const satisfies ReadonlyArray<keyof DisclosureEntry & string>;

export async function auditRoutes(app: FastifyInstance) {
  /**
   * Accounting of disclosures for one patient or order: who opened PHI (phi_access_events), what
   * happened to the order (order_events), and when a report conversation began. The export is
   * itself recorded in phi_access_events.
   */
  app.get('/api/bu/:slug/audit/disclosures', async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    const query = querySchema.parse(request.query);

    const result = await withTenant(ctx, async (tx) => {
      // Scope: the order named, or every order for the patient with that email. Both are read
      // through row-level security, so another business unit's orders can never appear here.
      const orderRows = await tx
        .select({ id: orders.id })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.patientUserId))
        .where(
          query.orderId
            ? eq(orders.id, query.orderId)
            : eq(users.email, query.patientEmail!.toLowerCase()),
        );
      if (query.orderId && orderRows.length === 0) throw notFound('Order not found');
      const orderIds = orderRows.map((row) => row.id);

      const entries: DisclosureEntry[] = [];
      let truncated = false;

      if (orderIds.length > 0) {
        const range = (column: Parameters<typeof gte>[0]): SQL[] => [
          ...(query.from ? [gte(column, query.from)] : []),
          ...(query.to ? [lte(column, query.to)] : []),
        ];

        const access = await tx
          .select({
            at: phiAccessEvents.createdAt,
            orderId: phiAccessEvents.orderId,
            actorEmail: users.email,
            actorRole: phiAccessEvents.actorRole,
            actingPlatformAdmin: phiAccessEvents.actingPlatformAdmin,
            resourceType: phiAccessEvents.resourceType,
            resourceId: phiAccessEvents.resourceId,
            action: phiAccessEvents.action,
            requestId: phiAccessEvents.requestId,
            ip: phiAccessEvents.ip,
          })
          .from(phiAccessEvents)
          .leftJoin(users, eq(users.id, phiAccessEvents.actorUserId))
          .where(
            and(
              inArray(phiAccessEvents.orderId, orderIds),
              ...range(phiAccessEvents.createdAt),
            ),
          )
          .orderBy(desc(phiAccessEvents.createdAt))
          .limit(PER_SOURCE_LIMIT + 1);

        const events = await tx
          .select({
            at: orderEvents.createdAt,
            orderId: orderEvents.orderId,
            actorEmail: users.email,
            actorRole: orderEvents.actorRole,
            toStatus: orderEvents.toStatus,
            message: orderEvents.message,
            metadata: orderEvents.metadata,
          })
          .from(orderEvents)
          .leftJoin(users, eq(users.id, orderEvents.actorUserId))
          .where(and(inArray(orderEvents.orderId, orderIds), ...range(orderEvents.createdAt)))
          .orderBy(desc(orderEvents.createdAt))
          .limit(PER_SOURCE_LIMIT + 1);

        const conversations = await tx
          .select({
            at: reportConversations.createdAt,
            orderId: reportConversations.orderId,
            actorEmail: users.email,
          })
          .from(reportConversations)
          .leftJoin(users, eq(users.id, reportConversations.patientUserId))
          .where(
            and(
              inArray(reportConversations.orderId, orderIds),
              ...range(reportConversations.createdAt),
            ),
          )
          .limit(PER_SOURCE_LIMIT + 1);

        truncated =
          access.length > PER_SOURCE_LIMIT ||
          events.length > PER_SOURCE_LIMIT ||
          conversations.length > PER_SOURCE_LIMIT;

        for (const row of access.slice(0, PER_SOURCE_LIMIT)) {
          entries.push({
            at: row.at,
            source: 'phi_access',
            orderId: row.orderId,
            actorEmail: row.actorEmail,
            actorRole: row.actorRole,
            actingPlatformAdmin: row.actingPlatformAdmin,
            resource: row.resourceType,
            action: row.action,
            detail: row.resourceId ?? '',
            requestId: row.requestId,
            ip: row.ip,
          });
        }
        for (const row of events.slice(0, PER_SOURCE_LIMIT)) {
          const actingAs =
            typeof row.metadata?.actingAsPlatformAdmin === 'string'
              ? row.metadata.actingAsPlatformAdmin
              : null;
          entries.push({
            at: row.at,
            source: 'order_event',
            orderId: row.orderId,
            actorEmail: row.actorEmail,
            actorRole: row.actorRole,
            actingPlatformAdmin: Boolean(actingAs),
            resource: 'order',
            action: row.toStatus ?? 'note',
            detail: row.message,
            requestId: null,
            ip: null,
          });
        }
        for (const row of conversations.slice(0, PER_SOURCE_LIMIT)) {
          entries.push({
            at: row.at,
            source: 'conversation',
            orderId: row.orderId,
            actorEmail: row.actorEmail,
            actorRole: 'patient',
            actingPlatformAdmin: false,
            resource: 'conversation',
            action: 'conversation_started',
            detail: '',
            requestId: null,
            ip: null,
          });
        }
        entries.sort((a, b) => b.at.getTime() - a.at.getTime());
      }

      // Recorded after the read so an export does not list itself, but in the same transaction so
      // an export cannot succeed without leaving its own trace.
      await recordPhiAccess(tx, request, ctx, {
        resourceType: 'disclosure_export',
        orderId: query.orderId ?? null,
        action: query.format === 'csv' ? 'export' : 'view',
      });

      return { entries, truncated, orderCount: orderIds.length };
    });

    if (query.format === 'csv') {
      const stamp = new Date().toISOString().slice(0, 10);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="disclosures-${stamp}.csv"`)
        .header('cache-control', 'no-store')
        .send(toCsv(CSV_COLUMNS, result.entries));
    }

    return reply.header('cache-control', 'no-store').send(result);
  });
}
