import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { MembershipRole } from '@nio/shared';
import { requireActor } from '../auth/context.js';
import { withPlatformScope, withTenant } from '../db/client.js';
import { businessUnits, kits, orders, packages, testTypes, users } from '../db/schema.js';
import { forbidden, notFound } from '../lib/errors.js';

const tokenParam = z.object({ token: z.string().min(10).max(64) });

interface ScanAction {
  id: string;
  label: string;
  method: 'POST';
  path: string;
}

/**
 * Fulfillment, the patient and the lab all scan the same sticker. What the scan *does* depends on
 * who is holding the phone and where the kit is in its lifecycle, so the routing decision lives
 * here rather than being encoded in three different QR codes.
 */
function actionsFor(
  role: MembershipRole,
  slug: string,
  orderId: string,
  kitId: string,
  kitStatus: string,
): ScanAction[] {
  const patientBase = `/api/bu/${slug}/patient/orders/${orderId}/kits/${kitId}`;

  switch (role) {
    case 'patient':
      if (kitStatus === 'shipped') {
        return [
          { id: 'confirm_received', label: 'Confirm kit received', method: 'POST', path: `${patientBase}/received` },
        ];
      }
      if (kitStatus === 'received_by_patient') {
        return [
          { id: 'send_to_lab', label: 'I have mailed my sample', method: 'POST', path: `${patientBase}/sent-to-lab` },
        ];
      }
      return [];

    case 'lab':
      if (kitStatus === 'sample_in_transit') {
        return [
          {
            id: 'check_in',
            label: 'Check sample in',
            method: 'POST',
            path: `/api/bu/${slug}/lab/kits/${kitId}/check-in`,
          },
        ];
      }
      if (kitStatus === 'received_by_lab' || kitStatus === 'processing') {
        return [
          {
            id: 'start_processing',
            label: 'Start processing',
            method: 'POST',
            path: `/api/bu/${slug}/lab/kits/${kitId}/start`,
          },
        ];
      }
      return [];

    default:
      return [];
  }
}

export async function scanRoutes(app: FastifyInstance) {
  app.get('/api/scan/:token', async (request) => {
    const { token } = tokenParam.parse(request.params);
    const actor = requireActor(request);

    // The token is the only handle the scanner has, so tenant resolution has to precede the
    // tenant check. Nothing is returned until membership in the resolved tenant is confirmed.
    const located = await withPlatformScope(async (tx) => {
      const [row] = await tx
        .select({ kitId: kits.id, orderId: kits.orderId, businessUnitId: kits.businessUnitId })
        .from(kits)
        .where(eq(kits.qrToken, token))
        .limit(1);
      return row ?? null;
    });

    if (!located) throw notFound('That code is not recognised');

    const membership = actor.memberships.find((m) => m.businessUnitId === located.businessUnitId);
    if (!membership) throw forbidden('You do not have access to this kit');
    if (membership.businessUnitStatus !== 'active') throw forbidden('This business unit is not active');

    return withTenant(located.businessUnitId, async (tx) => {
      const [detail] = await tx
        .select({
          kitId: kits.id,
          kitNumber: kits.kitNumber,
          kitStatus: kits.status,
          externalKitId: kits.externalKitId,
          testTypeName: testTypes.name,
          sampleType: testTypes.sampleType,
          orderId: orders.id,
          orderNumber: orders.orderNumber,
          orderStatus: orders.status,
          externalFulfillmentId: orders.externalFulfillmentId,
          packageName: packages.name,
          patientName: users.name,
          patientUserId: orders.patientUserId,
        })
        .from(kits)
        .innerJoin(orders, eq(orders.id, kits.orderId))
        .innerJoin(packages, eq(packages.id, orders.packageId))
        .innerJoin(testTypes, eq(testTypes.id, kits.testTypeId))
        .innerJoin(users, eq(users.id, orders.patientUserId))
        .where(eq(kits.id, located.kitId))
        .limit(1);

      if (!detail) throw notFound('Kit not found');

      // A patient may only scan their own kit, even inside a tenant they belong to.
      if (membership.role === 'patient' && detail.patientUserId !== actor.userId) {
        throw forbidden('This kit belongs to another patient');
      }

      const [businessUnit] = await withPlatformScope((platformTx) =>
        platformTx
          .select({
            name: businessUnits.name,
            labName: businessUnits.labName,
            labReturnAddress: businessUnits.labReturnAddress,
          })
          .from(businessUnits)
          .where(eq(businessUnits.id, located.businessUnitId))
          .limit(1),
      );

      return {
        businessUnit: {
          slug: membership.businessUnitSlug,
          name: membership.businessUnitName,
        },
        role: membership.role,
        kit: {
          id: detail.kitId,
          number: detail.kitNumber,
          status: detail.kitStatus,
          testTypeName: detail.testTypeName,
          sampleType: detail.sampleType,
          externalKitId: detail.externalKitId,
        },
        order: {
          id: detail.orderId,
          orderNumber: detail.orderNumber,
          status: detail.orderStatus,
          packageName: detail.packageName,
          externalFulfillmentId: detail.externalFulfillmentId,
          // Fulfillment and lab staff see the patient name; it is on the kit either way.
          patientName: membership.role === 'patient' ? null : detail.patientName,
        },
        /** Prepaid return label details, prefilled to the lab serving this business unit. */
        labReturnLabel:
          membership.role === 'patient'
            ? {
                labName: businessUnit?.labName ?? `${businessUnit?.name ?? ''} Laboratory`.trim(),
                address: businessUnit?.labReturnAddress ?? null,
                reference: detail.orderNumber,
              }
            : null,
        actions: actionsFor(
          membership.role,
          membership.businessUnitSlug,
          detail.orderId,
          detail.kitId,
          detail.kitStatus,
        ),
      };
    });
  });
}
