import { z } from 'zod';
import type { ActorRole } from './roles.js';

/** High-level, patient-visible state of an order. Rolled up from its kits. */
export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'dispatched_to_fulfillment',
  'kit_shipped',
  'kit_received_by_patient',
  'sample_in_transit',
  'received_by_lab',
  'lab_processing',
  'lab_complete',
  'awaiting_clinician_review',
  'clinician_approved',
  'clinician_rejected',
  'results_released',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const orderStatusSchema = z.enum(ORDER_STATUSES);

/** Physical lifecycle of one test kit. A package may require several. */
export const KIT_STATUSES = [
  'awaiting_fulfillment',
  'labeled',
  'shipped',
  'received_by_patient',
  'sample_in_transit',
  'received_by_lab',
  'processing',
  'lab_complete',
  'problem',
] as const;
export type KitStatus = (typeof KIT_STATUSES)[number];
export const kitStatusSchema = z.enum(KIT_STATUSES);

type Transition = { to: OrderStatus; roles: readonly ActorRole[] };

/**
 * The single source of truth for order progression. Any status change not listed here is
 * rejected by the API, so no portal can skip a step or move an order backwards.
 */
const TRANSITIONS: Record<OrderStatus, readonly Transition[]> = {
  pending_payment: [
    { to: 'paid', roles: ['patient', 'system'] },
    { to: 'cancelled', roles: ['patient', 'bu_admin'] },
  ],
  paid: [
    { to: 'dispatched_to_fulfillment', roles: ['system'] },
    { to: 'cancelled', roles: ['bu_admin'] },
  ],
  dispatched_to_fulfillment: [
    { to: 'kit_shipped', roles: ['fulfillment'] },
    { to: 'cancelled', roles: ['bu_admin'] },
  ],
  kit_shipped: [
    { to: 'kit_received_by_patient', roles: ['patient', 'fulfillment'] },
    { to: 'cancelled', roles: ['bu_admin'] },
  ],
  kit_received_by_patient: [
    { to: 'sample_in_transit', roles: ['patient'] },
    { to: 'cancelled', roles: ['bu_admin'] },
  ],
  sample_in_transit: [
    { to: 'received_by_lab', roles: ['lab'] },
    { to: 'cancelled', roles: ['bu_admin'] },
  ],
  received_by_lab: [{ to: 'lab_processing', roles: ['lab'] }],
  lab_processing: [{ to: 'lab_complete', roles: ['lab'] }],
  lab_complete: [
    { to: 'awaiting_clinician_review', roles: ['system'] },
    { to: 'results_released', roles: ['system'] },
  ],
  awaiting_clinician_review: [
    { to: 'clinician_approved', roles: ['doctor'] },
    { to: 'clinician_rejected', roles: ['doctor'] },
  ],
  clinician_approved: [{ to: 'results_released', roles: ['system'] }],
  clinician_rejected: [{ to: 'results_released', roles: ['system'] }],
  results_released: [],
  cancelled: [],
};

export function allowedTransitions(from: OrderStatus): readonly Transition[] {
  return TRANSITIONS[from];
}

export function canTransition(from: OrderStatus, to: OrderStatus, role: ActorRole): boolean {
  // Platform admins can observe everything but are never the actor on a clinical transition.
  return TRANSITIONS[from].some((t) => t.to === to && t.roles.includes(role));
}

export function assertTransition(from: OrderStatus, to: OrderStatus, role: ActorRole): void {
  if (!canTransition(from, to, role)) {
    throw new Error(`Illegal transition ${from} -> ${to} for role ${role}`);
  }
}

/** Where each kit stage places the parent order on the order-status timeline. */
const KIT_TO_ORDER_STAGE: Record<Exclude<KitStatus, 'problem'>, OrderStatus> = {
  awaiting_fulfillment: 'dispatched_to_fulfillment',
  labeled: 'dispatched_to_fulfillment',
  shipped: 'kit_shipped',
  received_by_patient: 'kit_received_by_patient',
  sample_in_transit: 'sample_in_transit',
  received_by_lab: 'received_by_lab',
  processing: 'lab_processing',
  lab_complete: 'lab_complete',
};

const ORDER_STATUS_RANK = new Map<OrderStatus, number>(ORDER_STATUSES.map((s, i) => [s, i]));

export function orderStatusRank(status: OrderStatus): number {
  return ORDER_STATUS_RANK.get(status) ?? -1;
}

/**
 * An order only advances once every kit has. Kits flagged `problem` are excluded so a single
 * damaged kit does not silently drag the order backwards; the order issue surfaces separately.
 */
export function rollupOrderStatus(kitStatuses: readonly KitStatus[]): OrderStatus | null {
  const relevant = kitStatuses.filter((s): s is Exclude<KitStatus, 'problem'> => s !== 'problem');
  if (relevant.length === 0) return null;

  let least: OrderStatus | null = null;
  for (const kitStatus of relevant) {
    const stage = KIT_TO_ORDER_STAGE[kitStatus];
    if (least === null || orderStatusRank(stage) < orderStatusRank(least)) {
      least = stage;
    }
  }
  return least;
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: 'Pending payment',
  paid: 'Paid',
  dispatched_to_fulfillment: 'Sent to fulfillment',
  kit_shipped: 'Kit shipped',
  kit_received_by_patient: 'Kit received',
  sample_in_transit: 'Sample in transit',
  received_by_lab: 'Received by lab',
  lab_processing: 'Lab processing',
  lab_complete: 'Lab analysis complete',
  awaiting_clinician_review: 'Awaiting doctor review',
  clinician_approved: 'Doctor approved',
  clinician_rejected: 'Doctor rejected',
  results_released: 'Results available',
  cancelled: 'Cancelled',
};

export const KIT_STATUS_LABELS: Record<KitStatus, string> = {
  awaiting_fulfillment: 'Awaiting fulfillment',
  labeled: 'Labeled',
  shipped: 'Shipped',
  received_by_patient: 'Received by patient',
  sample_in_transit: 'Sample in transit',
  received_by_lab: 'Received by lab',
  processing: 'Processing',
  lab_complete: 'Analysis complete',
  problem: 'Problem flagged',
};
