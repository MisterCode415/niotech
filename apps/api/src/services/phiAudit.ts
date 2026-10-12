import type { FastifyRequest } from 'fastify';
import type { Tx } from '../db/client.js';
import { phiAccessEvents, type PhiAccessAction, type PhiResourceType } from '../db/schema.js';
import type { TenantContext } from '../auth/context.js';

export interface PhiAccessInput {
  resourceType: PhiResourceType;
  /** The file, review, or conversation touched; omitted for whole-order views. */
  resourceId?: string | null;
  /** Null for events that are not about one order, such as a patient-wide disclosure export. */
  orderId?: string | null;
  action: PhiAccessAction;
}

/**
 * Appends one row to the PHI access trail inside the caller's transaction. Because it shares the
 * transaction with the read, a failed audit write fails the read: PHI is never disclosed without
 * a record. The row stores identifiers only, never report text or message content.
 */
export async function recordPhiAccess(
  tx: Tx,
  request: Pick<FastifyRequest, 'id' | 'ip'>,
  ctx: Pick<TenantContext, 'userId' | 'businessUnitId' | 'actorRole' | 'actingAsPlatformAdmin'>,
  input: PhiAccessInput,
): Promise<void> {
  await tx.insert(phiAccessEvents).values({
    businessUnitId: ctx.businessUnitId,
    actorUserId: ctx.userId,
    actorRole: ctx.actorRole,
    actingPlatformAdmin: Boolean(ctx.actingAsPlatformAdmin),
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    orderId: input.orderId ?? null,
    action: input.action,
    requestId: String(request.id),
    ip: request.ip,
  });
}
