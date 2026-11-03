import { and, eq, isNull } from 'drizzle-orm';
import {
  isAllowedReturnUrl,
  type CheckoutAttribution,
  type CreateCheckoutIntentInput,
} from '@nio/shared';
import { withTenant, type Tx } from '../db/client.js';
import { checkoutIntents, packages } from '../db/schema.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';

/** Long enough to survive a slow Stripe session, short enough that a leaked link goes stale. */
export const CHECKOUT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

interface IntentBusinessUnit {
  id: string;
  slug: string;
  marketingOrigins: string[];
}

/** An empty tag set is stored as null so reports never have to distinguish `{}` from absent. */
export function cleanAttribution(
  value: CheckoutAttribution | null | undefined,
): CheckoutAttribution | null {
  if (!value) return null;
  return Object.keys(value).length > 0 ? value : null;
}

export async function createCheckoutIntent(
  businessUnit: IntentBusinessUnit,
  input: CreateCheckoutIntentInput,
) {
  if (input.returnUrl && !isAllowedReturnUrl(input.returnUrl, businessUnit.marketingOrigins)) {
    throw badRequest('Return URL is not on this business unit’s marketing-site allowlist');
  }

  return withTenant(businessUnit.id, async (tx) => {
    const [pkg] = await tx
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.id, input.packageId), eq(packages.status, 'active')))
      .limit(1);
    if (!pkg) throw notFound('Package not available');

    const [intent] = await tx
      .insert(checkoutIntents)
      .values({
        businessUnitId: businessUnit.id,
        packageId: pkg.id,
        returnUrl: input.returnUrl ?? null,
        attribution: cleanAttribution(input.attribution),
        expiresAt: new Date(Date.now() + CHECKOUT_INTENT_TTL_MS),
      })
      .returning();
    return intent!;
  });
}

export interface ResolvedCheckoutIntent {
  id: string;
  packageId: string;
  /** Re-validated against the current allowlist; null if it was never set or has been removed. */
  returnUrl: string | null;
  attribution: CheckoutAttribution | null;
  expiresAt: Date;
}

export async function resolveCheckoutIntent(
  businessUnit: IntentBusinessUnit,
  intentId: string,
): Promise<ResolvedCheckoutIntent> {
  // The tenant scope is what stops one business unit's intent from resolving under another slug.
  const [intent] = await withTenant(businessUnit.id, (tx) =>
    tx.select().from(checkoutIntents).where(eq(checkoutIntents.id, intentId)).limit(1),
  );
  if (!intent) throw notFound('Checkout link not found');
  if (intent.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(410, 'This checkout link has expired', 'INTENT_EXPIRED');
  }

  const [pkg] = await withTenant(businessUnit.id, (tx) =>
    tx
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.id, intent.packageId), eq(packages.status, 'active')))
      .limit(1),
  );
  if (!pkg) throw notFound('Package not available');

  const returnUrl =
    intent.returnUrl && isAllowedReturnUrl(intent.returnUrl, businessUnit.marketingOrigins)
      ? intent.returnUrl
      : null;

  return {
    id: intent.id,
    packageId: intent.packageId,
    returnUrl,
    attribution: intent.attribution,
    expiresAt: intent.expiresAt,
  };
}

/** Records that an order came from this intent. Silent when it is unknown, expired, or reused. */
export async function markIntentConsumed(
  tx: Tx,
  intentId: string,
  packageId: string,
): Promise<void> {
  await tx
    .update(checkoutIntents)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(checkoutIntents.id, intentId),
        eq(checkoutIntents.packageId, packageId),
        isNull(checkoutIntents.consumedAt),
      ),
    );
}
