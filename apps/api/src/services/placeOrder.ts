import { and, eq } from 'drizzle-orm';
import type { ActorRole, Address, CheckoutAttribution, ShippingMethod } from '@nio/shared';
import type { Tx } from '../db/client.js';
import { orders, packageTestTypes, packages, testTypes } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { generateOrderNumber } from '../lib/ids.js';
import { cleanAttribution, markIntentConsumed } from './checkoutIntents.js';
import { recordEvent } from './orderWorkflow.js';

export interface PlaceOrderInput {
  businessUnitId: string;
  patientUserId: string;
  actorRole: ActorRole;
  actorUserId: string | null;
  packageId: string;
  shippingAddress: Address;
  shippingMethod: ShippingMethod;
  attribution?: CheckoutAttribution | null | undefined;
  intentId?: string | undefined;
  /** The shopper had no account when ordering; the activation invite waits for payment. */
  guestActivation?: boolean;
}

/**
 * Creates a `pending_payment` order from the catalog. The price and package contents are always
 * read here, inside the tenant's transaction, so no caller can influence what is charged. The
 * caller owns the transaction and decides how the order is then paid.
 */
export async function placeOrder(tx: Tx, input: PlaceOrderInput) {
  const [pkg] = await tx
    .select()
    .from(packages)
    .where(and(eq(packages.id, input.packageId), eq(packages.status, 'active')))
    .limit(1);
  if (!pkg) throw notFound('Package not available');

  const composition = await tx
    .select({
      testTypeId: testTypes.id,
      name: testTypes.name,
      sampleType: testTypes.sampleType,
      turnaroundDays: testTypes.turnaroundDays,
      quantity: packageTestTypes.quantity,
    })
    .from(packageTestTypes)
    .innerJoin(testTypes, eq(testTypes.id, packageTestTypes.testTypeId))
    .where(eq(packageTestTypes.packageId, pkg.id));
  if (composition.length === 0) throw badRequest('Package has no test types configured');

  const [created] = await tx
    .insert(orders)
    .values({
      businessUnitId: input.businessUnitId,
      orderNumber: generateOrderNumber(),
      patientUserId: input.patientUserId,
      packageId: pkg.id,
      status: 'pending_payment',
      priceCents: pkg.priceCents,
      paymentStatus: 'unpaid',
      packageSnapshot: {
        packageName: pkg.name,
        packageVersion: pkg.version,
        priceCents: pkg.priceCents,
        requiresClinician: pkg.requiresClinician,
        internalReference: pkg.internalReference,
        externalProductId: pkg.externalProductId,
        tests: composition,
      },
      shippingAddress: input.shippingAddress,
      shippingMethod: input.shippingMethod,
      requiresClinician: pkg.requiresClinician,
      attribution: cleanAttribution(input.attribution),
      guestActivation: input.guestActivation ?? false,
    })
    .returning();

  await recordEvent(tx, {
    businessUnitId: input.businessUnitId,
    orderId: created!.id,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    toStatus: 'pending_payment',
    message: input.guestActivation
      ? `Guest order placed for ${pkg.name}`
      : `Order placed for ${pkg.name}`,
    metadata: { packageId: pkg.id },
  });

  if (input.intentId) await markIntentConsumed(tx, input.intentId, pkg.id);

  return created!;
}
