import { and, eq, isNull, lte } from 'drizzle-orm';
import { workspacePath } from '@nio/shared';
import { withPlatformScope } from '../db/client.js';
import { businessUnits, orders, users } from '../db/schema.js';
import { describeError } from '../lib/logSafe.js';
import { ensurePatient } from './patients.js';

/**
 * Sends the account-activation invite for a paid guest order, at most once.
 *
 * The send is claimed first (by stamping `activation_invite_sent_at` only where it is still null),
 * so a replayed Stripe event, the payment reconcile button, and the retry sweep can all call this
 * for the same order without the shopper receiving two links. If delivery fails the claim is
 * released and the sweep tries again. Returns true only when this call sent the invite.
 */
async function sendOrderActivationInvite(orderId: string): Promise<boolean> {
  const claimed = await withPlatformScope(async (tx) => {
    const [row] = await tx
      .update(orders)
      .set({ activationInviteSentAt: new Date() })
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.guestActivation, true),
          isNull(orders.activationInviteSentAt),
          // Never provision an identity for an unpaid, abandoned, or refunded checkout.
          eq(orders.paymentStatus, 'paid'),
        ),
      )
      .returning({
        businessUnitId: orders.businessUnitId,
        patientUserId: orders.patientUserId,
      });
    return row;
  });
  if (!claimed) return false;

  try {
    const { businessUnit, user } = await withPlatformScope(async (tx) => {
      const [bu] = await tx
        .select()
        .from(businessUnits)
        .where(eq(businessUnits.id, claimed.businessUnitId))
        .limit(1);
      const [patient] = await tx
        .select()
        .from(users)
        .where(eq(users.id, claimed.patientUserId))
        .limit(1);
      if (!bu || !patient) throw new Error('Order references a missing business unit or patient');
      return { businessUnit: bu, user: patient };
    });

    await ensurePatient({
      businessUnit,
      email: user.email,
      name: user.name,
      returnTo: workspacePath(businessUnit.slug, 'patient', `/orders/${orderId}`),
      invite: 'now',
      // The name was typed by an anonymous shopper; it must never overwrite an existing account's.
      rename: false,
    });
    return true;
  } catch (error) {
    await withPlatformScope((tx) =>
      tx.update(orders).set({ activationInviteSentAt: null }).where(eq(orders.id, orderId)),
    );
    console.warn('Activation invite failed; will retry', describeError(error));
    return false;
  }
}

/** Called right after a payment commits. Failures are logged and retried by the sweep. */
export async function sendOrderActivationInvites(orderIds: readonly string[]): Promise<void> {
  for (const orderId of orderIds) {
    try {
      await sendOrderActivationInvite(orderId);
    } catch (error) {
      // Never let a delivery problem fail the payment path that called us; the sweep retries.
      console.warn('Activation invite could not be processed', describeError(error));
    }
  }
}

/** Safety net for invites whose first attempt failed or whose process died mid-send. */
export async function sweepPendingActivationInvites(limit = 20): Promise<void> {
  const settledBefore = new Date(Date.now() - 60_000);
  const pending = await withPlatformScope((tx) =>
    tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.guestActivation, true),
          isNull(orders.activationInviteSentAt),
          eq(orders.paymentStatus, 'paid'),
          lte(orders.updatedAt, settledBefore),
        ),
      )
      .limit(limit),
  );
  await sendOrderActivationInvites(pending.map((row) => row.id));
}
