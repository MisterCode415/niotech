import { KIT_STATUS_LABELS, ROLE_LABELS, type KitStatus } from '@nio/shared';
import type { Tx } from '../db/client.js';
import { labResults, shipments } from '../db/schema.js';
import {
  recordEvent,
  setKitStatus,
  syncOrderFromKits,
  type WorkflowActor,
} from './orderWorkflow.js';

/**
 * The physical journey of a kit, in order. Everything a scan can catch up on lies on this chain;
 * once the lab has a kit, progress is driven by uploads and analysis rather than by custody.
 */
export const CUSTODY_CHAIN = [
  'awaiting_fulfillment',
  'labeled',
  'shipped',
  'received_by_patient',
  'sample_in_transit',
  'received_by_lab',
] as const satisfies readonly KitStatus[];

export type CustodyStatus = (typeof CUSTODY_CHAIN)[number];

export function custodyIndex(status: KitStatus): number {
  return (CUSTODY_CHAIN as readonly KitStatus[]).indexOf(status);
}

export interface CustodyKit {
  id: string;
  orderId: string;
  kitNumber: number;
  status: KitStatus;
}

export interface Custodian {
  businessUnitId: string;
  userId: string;
}

function actorFor(custodian: Custodian, role: 'patient' | 'lab'): WorkflowActor {
  return {
    businessUnitId: custodian.businessUnitId,
    actorRole: role,
    actorUserId: custodian.userId,
  };
}

/** The patient has the kit in hand. */
export async function markReceivedByPatient(tx: Tx, custodian: Custodian, kit: CustodyKit) {
  const actor = actorFor(custodian, 'patient');
  await setKitStatus(tx, actor, kit.id, 'received_by_patient');
  await recordEvent(tx, {
    businessUnitId: custodian.businessUnitId,
    orderId: kit.orderId,
    kitId: kit.id,
    actorUserId: custodian.userId,
    actorRole: 'patient',
    message: `Kit #${kit.kitNumber} confirmed received by patient`,
  });
  await syncOrderFromKits(tx, actor, kit.orderId, 'All kits received by patient');
}

/** The sample is boxed with the prepaid lab label and dropped in the mail. */
export async function markSampleSent(tx: Tx, custodian: Custodian, kit: CustodyKit) {
  const actor = actorFor(custodian, 'patient');
  await setKitStatus(tx, actor, kit.id, 'sample_in_transit');
  await recordEvent(tx, {
    businessUnitId: custodian.businessUnitId,
    orderId: kit.orderId,
    kitId: kit.id,
    actorUserId: custodian.userId,
    actorRole: 'patient',
    message: `Sample for kit #${kit.kitNumber} sent to the lab`,
  });
  await recordInboundShipment(tx, custodian.businessUnitId, kit.orderId);
  await syncOrderFromKits(tx, actor, kit.orderId, 'All samples are in transit to the lab');
}

/** Physical arrival at goods-in; opens the lab result record for this kit. */
export async function checkInAtLab(tx: Tx, custodian: Custodian, kit: CustodyKit) {
  const actor = actorFor(custodian, 'lab');
  await setKitStatus(tx, actor, kit.id, 'received_by_lab');
  await recordEvent(tx, {
    businessUnitId: custodian.businessUnitId,
    orderId: kit.orderId,
    kitId: kit.id,
    actorUserId: custodian.userId,
    actorRole: 'lab',
    message: `Sample for kit #${kit.kitNumber} checked in at the lab`,
  });

  await tx
    .insert(labResults)
    .values({
      businessUnitId: custodian.businessUnitId,
      orderId: kit.orderId,
      kitId: kit.id,
      labUserId: custodian.userId,
      receivedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: labResults.kitId,
      set: { receivedAt: new Date(), labUserId: custodian.userId },
    });

  await syncOrderFromKits(tx, actor, kit.orderId, 'All samples received by the lab');
}

async function recordInboundShipment(tx: Tx, businessUnitId: string, orderId: string) {
  await tx
    .insert(shipments)
    .values({ businessUnitId, orderId, direction: 'inbound_to_lab', shippedAt: new Date() })
    .onConflictDoNothing();
}

/**
 * Walks a kit forward to `target` on behalf of whoever just scanned it. Holding the kit proves
 * every earlier hand-off happened, so missed steps are recorded by the system (attributed to the
 * scanner, flagged `advancedByScan`) one at a time, letting the order follow through each legal
 * transition. The final step is the scanner's own and is recorded exactly as if they had pressed
 * the button.
 */
export async function advanceKitTo(
  tx: Tx,
  custodian: Custodian & { role: 'patient' | 'lab' },
  kit: CustodyKit,
  target: 'received_by_patient' | 'received_by_lab',
): Promise<{ caughtUp: CustodyStatus[] }> {
  const from = custodyIndex(kit.status);
  const to = custodyIndex(target);
  if (from < 0 || from >= to) return { caughtUp: [] };

  const caughtUp: CustodyStatus[] = [];
  const system: WorkflowActor = {
    businessUnitId: custodian.businessUnitId,
    actorRole: 'system',
    actorUserId: custodian.userId,
  };

  for (let index = from + 1; index < to; index += 1) {
    const step = CUSTODY_CHAIN[index]!;
    await setKitStatus(tx, system, kit.id, step);
    await recordEvent(tx, {
      businessUnitId: custodian.businessUnitId,
      orderId: kit.orderId,
      kitId: kit.id,
      actorUserId: custodian.userId,
      actorRole: 'system',
      message: `Kit #${kit.kitNumber} marked "${KIT_STATUS_LABELS[step]}" when the ${ROLE_LABELS[custodian.role].toLowerCase()} scanned it`,
      metadata: { advancedByScan: { role: custodian.role, step } },
    });
    if (step === 'sample_in_transit') {
      await recordInboundShipment(tx, custodian.businessUnitId, kit.orderId);
    }
    await syncOrderFromKits(
      tx,
      system,
      kit.orderId,
      `Advanced when the ${custodian.role} scanned a kit`,
    );
    caughtUp.push(step);
  }

  const current = { ...kit, status: CUSTODY_CHAIN[to - 1]! };
  if (target === 'received_by_patient') await markReceivedByPatient(tx, custodian, current);
  else await checkInAtLab(tx, custodian, current);

  return { caughtUp };
}
