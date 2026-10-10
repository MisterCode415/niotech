import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  MEMBERSHIP_ROLES,
  normalizeKitSerial,
  workspacePath,
  type KitStatus,
  type MembershipRole,
} from '@nio/shared';
import { requireActor, type Actor, type ActorMembership } from '../auth/context.js';
import { withPlatformScope, withTenant } from '../db/client.js';
import { businessUnits, kits, orders, packages, testTypes, users } from '../db/schema.js';
import { forbidden, HttpError, notFound } from '../lib/errors.js';
import { advanceKitTo, custodyIndex } from '../services/kitCustody.js';

const codeParam = z.object({ code: z.string().min(6).max(64) });
const roleChoice = z.object({ as: z.enum(MEMBERSHIP_ROLES).optional() });

/** Roughly one scan every two seconds is far beyond any real goods-in desk, and stops serial probing. */
const SCAN_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

interface ScanAction {
  id: string;
  label: string;
  method: 'POST';
  path: string;
}

type ScanOutcome =
  'none' | 'registered_received' | 'checked_in' | 'open_for_results' | 'open_order';

interface ScannedKit {
  kitId: string;
  kitNumber: number;
  serial: string;
  kitStatus: KitStatus;
  orderId: string;
  patientUserId: string;
}

/** Roles a scan acts on, in the order a person holding several should be offered them. */
const ROLE_PRIORITY: MembershipRole[] = ['lab', 'fulfillment', 'patient', 'bu_admin', 'doctor'];

/**
 * Fulfillment, the patient and the lab all scan the same sticker. What the scan *does* depends on
 * who is holding the phone and where the kit is in its lifecycle, so the routing decision lives
 * here rather than being encoded in three different QR codes.
 */
function hasWork(role: MembershipRole, kit: ScannedKit, userId: string): boolean {
  const position = custodyIndex(kit.kitStatus);
  switch (role) {
    case 'patient':
      return (
        kit.patientUserId === userId &&
        position >= 0 &&
        position <= custodyIndex('received_by_patient')
      );
    case 'lab':
      return position >= 0 || kit.kitStatus === 'processing';
    case 'fulfillment':
      return position >= 0 && position <= custodyIndex('labeled');
    default:
      return false;
  }
}

/** Buttons for anything the scan itself did not do automatically. */
function actionsFor(role: MembershipRole | null, slug: string, kit: ScannedKit): ScanAction[] {
  const patientBase = `/api/bu/${slug}/patient/orders/${kit.orderId}/kits/${kit.kitId}`;
  if (role === 'patient' && kit.kitStatus === 'received_by_patient') {
    return [
      {
        id: 'send_to_lab',
        label: "I've mailed my sample",
        method: 'POST',
        path: `${patientBase}/sent-to-lab`,
      },
    ];
  }
  if (role === 'patient' && kit.kitStatus === 'shipped') {
    return [
      {
        id: 'confirm_received',
        label: 'Confirm kit received',
        method: 'POST',
        path: `${patientBase}/received`,
      },
    ];
  }
  if (role === 'lab' && kit.kitStatus === 'sample_in_transit') {
    return [
      {
        id: 'check_in',
        label: 'Check sample in',
        method: 'POST',
        path: `/api/bu/${slug}/lab/kits/${kit.kitId}/check-in`,
      },
    ];
  }
  return [];
}

function orderPathFor(role: MembershipRole | null, slug: string, kit: ScannedKit): string | null {
  switch (role) {
    case 'patient':
      return workspacePath(slug, 'patient', `/orders/${kit.orderId}`);
    case 'lab':
      return `${workspacePath(slug, 'lab', `/orders/${kit.orderId}`)}?kit=${kit.kitId}`;
    case 'fulfillment':
      return workspacePath(slug, 'fulfillment', `/orders/${kit.orderId}`);
    case 'bu_admin':
      return workspacePath(slug, 'bu_admin', '/orders');
    case 'doctor':
      return workspacePath(slug, 'doctor');
    default:
      return null;
  }
}

/**
 * The code is either the QR token or the serial printed beneath it. Anything that reads as a
 * serial is looked up as one; a 22-character token can never normalize to a serial.
 */
async function locateKit(code: string) {
  const serial = normalizeKitSerial(code);
  return withPlatformScope(async (tx) => {
    const [row] = await tx
      .select({ kitId: kits.id, businessUnitId: kits.businessUnitId })
      .from(kits)
      .where(serial ? eq(kits.serial, serial) : eq(kits.qrToken, code))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Resolves who is scanning and in which capacity. A kit outside every business unit the caller
 * belongs to is reported as unknown, so a typed serial cannot confirm another tenant's kit exists.
 */
async function resolveScan(request: FastifyRequest, code: string, requestedRole?: MembershipRole) {
  const actor = requireActor(request);
  const located = await locateKit(code);
  const notRecognised = notFound('That code is not recognised');
  if (!located || !actor.userId) throw notRecognised;

  const memberships = actor.memberships.filter((m) => m.businessUnitId === located.businessUnitId);
  if (memberships.length === 0) throw notRecognised;
  const anchor = memberships[0]!;
  if (anchor.businessUnitStatus !== 'active') throw forbidden('This business unit is not active');
  requireScanOrganization(actor, anchor);

  const roles = memberships.map((m) => m.role);
  // Staff roles can read any kit in the tenant; a patient-only scanner reads through patient RLS,
  // which hides kits they do not own exactly as if the code were unknown.
  const readRole =
    ROLE_PRIORITY.find((role) => role !== 'patient' && roles.includes(role)) ?? 'patient';
  const scope = { businessUnitId: located.businessUnitId, userId: actor.userId };
  const kit = await loadKit(scope, readRole, located.kitId);
  if (!kit) throw notRecognised;

  const candidates = ROLE_PRIORITY.filter(
    (role) => roles.includes(role) && hasWork(role, kit, actor.userId!),
  );
  let role: MembershipRole | null;
  let roleChoices: MembershipRole[] = [];
  if (requestedRole && roles.includes(requestedRole)) {
    role = requestedRole;
  } else if (candidates.length > 1) {
    role = null;
    roleChoices = candidates;
  } else {
    const isOwner = kit.patientUserId === actor.userId;
    role =
      candidates[0] ??
      ROLE_PRIORITY.find((r) => roles.includes(r) && (r !== 'patient' || isOwner)) ??
      null;
  }
  if (role === 'patient' && kit.patientUserId !== actor.userId) throw notRecognised;

  return { actor, anchor, scope, kit, readRole, role, roleChoices };
}

/**
 * Auth0 sessions are scoped to one organization. A member scanning from an org-less or
 * other-org session gets a recoverable error naming the organization to sign in to, so the
 * scan page can re-authenticate and land back on the same code.
 */
export function requireScanOrganization(actor: Actor, membership: ActorMembership): void {
  if (actor.identity.provider !== 'auth0') return;
  if (actor.identity.orgId && actor.identity.orgId === membership.auth0OrgId) return;
  if (!actor.identity.orgId && !membership.auth0OrgId) return;
  throw new HttpError(
    409,
    `Sign in to ${membership.businessUnitName} to use this kit`,
    'ORGANIZATION_REQUIRED',
    { organization: membership.auth0OrgId },
  );
}

async function loadKit(
  scope: { businessUnitId: string; userId: string },
  role: MembershipRole,
  kitId: string,
): Promise<ScannedKit | null> {
  return withTenant({ ...scope, actorRole: role }, async (tx) => {
    const [row] = await tx
      .select({
        kitId: kits.id,
        kitNumber: kits.kitNumber,
        serial: kits.serial,
        kitStatus: kits.status,
        orderId: kits.orderId,
        patientUserId: orders.patientUserId,
      })
      .from(kits)
      .innerJoin(orders, eq(orders.id, kits.orderId))
      .where(eq(kits.id, kitId))
      .limit(1);
    return row ?? null;
  });
}

async function buildView(
  scan: Awaited<ReturnType<typeof resolveScan>>,
  outcome: ScanOutcome,
  redirect: string | null,
  caughtUp: string[],
) {
  const { anchor, scope, role, roleChoices } = scan;

  return withTenant({ ...scope, actorRole: role ?? scan.readRole }, async (tx) => {
    const [detail] = await tx
      .select({
        kitId: kits.id,
        kitNumber: kits.kitNumber,
        serial: kits.serial,
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
      .where(eq(kits.id, scan.kit.kitId))
      .limit(1);
    if (!detail) throw notFound('That code is not recognised');

    const [businessUnit] = await withPlatformScope((platformTx) =>
      platformTx
        .select({
          name: businessUnits.name,
          labName: businessUnits.labName,
          labReturnAddress: businessUnits.labReturnAddress,
        })
        .from(businessUnits)
        .where(eq(businessUnits.id, scope.businessUnitId))
        .limit(1),
    );

    const kit: ScannedKit = { ...scan.kit, kitStatus: detail.kitStatus };
    const isStaff = role !== null && role !== 'patient';

    return {
      businessUnit: { slug: anchor.businessUnitSlug, name: anchor.businessUnitName },
      role,
      roleChoices,
      outcome,
      redirect,
      caughtUp,
      kit: {
        id: detail.kitId,
        number: detail.kitNumber,
        serial: detail.serial,
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
        patientName: isStaff ? detail.patientName : null,
      },
      /** Prepaid return label details, prefilled to the lab serving this business unit. */
      labReturnLabel:
        role === 'patient'
          ? {
              labName: businessUnit?.labName ?? `${businessUnit?.name ?? ''} Laboratory`.trim(),
              address: businessUnit?.labReturnAddress ?? null,
              reference: detail.orderNumber,
            }
          : null,
      orderPath: orderPathFor(role, anchor.businessUnitSlug, kit),
      actions: actionsFor(role, anchor.businessUnitSlug, kit),
    };
  });
}

export async function scanRoutes(app: FastifyInstance) {
  /** Read-only: what this kit is and what the scanner could do with it. */
  app.get('/api/scan/:code', SCAN_RATE_LIMIT, async (request) => {
    const { code } = codeParam.parse(request.params);
    const { as } = roleChoice.parse(request.query);
    const scan = await resolveScan(request, code, as);
    return buildView(scan, 'none', null, []);
  });

  /**
   * A scan landing in the app. Performs the scanner's next custody step (catching up any the
   * records missed) or tells the page where the scanner's work on this kit continues. Repeat
   * scans are harmless: the status has already moved, so they only redirect or report.
   */
  app.post('/api/scan/:code', SCAN_RATE_LIMIT, async (request) => {
    const { code } = codeParam.parse(request.params);
    const { as } = roleChoice.parse(request.body ?? {});
    const scan = await resolveScan(request, code, as);
    const { scope, role, kit, anchor } = scan;
    const slug = anchor.businessUnitSlug;

    if (!role) return buildView(scan, 'none', null, []);

    const position = custodyIndex(kit.kitStatus);
    const custodyKit = {
      id: kit.kitId,
      orderId: kit.orderId,
      kitNumber: kit.kitNumber,
      status: kit.kitStatus,
    };

    if (role === 'patient' && position >= 0 && position < custodyIndex('received_by_patient')) {
      const { caughtUp } = await withTenant({ ...scope, actorRole: 'patient' }, (tx) =>
        advanceKitTo(tx, { ...scope, role: 'patient' }, custodyKit, 'received_by_patient'),
      );
      return buildView(scan, 'registered_received', null, caughtUp);
    }

    if (role === 'lab') {
      if (position >= 0 && position < custodyIndex('received_by_lab')) {
        const { caughtUp } = await withTenant({ ...scope, actorRole: 'lab' }, (tx) =>
          advanceKitTo(tx, { ...scope, role: 'lab' }, custodyKit, 'received_by_lab'),
        );
        return buildView(scan, 'checked_in', null, caughtUp);
      }
      if (kit.kitStatus === 'received_by_lab' || kit.kitStatus === 'processing') {
        return buildView(scan, 'open_for_results', orderPathFor('lab', slug, kit), []);
      }
    }

    if (role === 'fulfillment' && hasWork('fulfillment', kit, scope.userId)) {
      return buildView(scan, 'open_order', orderPathFor('fulfillment', slug, kit), []);
    }

    return buildView(scan, 'none', null, []);
  });
}
