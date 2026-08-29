import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { env, smtpIsLocalCapture } from '../env.js';
import { withTenant } from '../db/client.js';
import { notifications } from '../db/schema.js';

export interface NotificationIntent {
  businessUnitId: string;
  userId: string;
  email: string;
  type: string;
  title: string;
  body: string;
  linkPath?: string;
  orderId?: string;
}

/**
 * Local capture (Mailpit) speaks plain SMTP with no credentials. Anything else is a relay reached
 * over a network, where the connection carries both a password and patient-identifying subject
 * lines, so TLS is required rather than merely attempted.
 */
const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  // Port 465 is implicit TLS; 587 and 25 start in the clear and upgrade with STARTTLS.
  secure: env.SMTP_PORT === 465,
  ignoreTLS: smtpIsLocalCapture,
  requireTLS: !smtpIsLocalCapture,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
});

/**
 * Sends an invitee the one-time link that sets their first password. This deliberately skips the
 * in-app notification that other messages write: the recipient has no way to sign in and read it
 * yet, which is the entire point of the mail.
 *
 * Unlike `dispatchNotifications`, a delivery failure is raised rather than logged. The link is not
 * stored anywhere and cannot be reissued from what the caller holds, so swallowing the error would
 * strand an account that nobody can reach.
 */
export async function sendInvitationEmail(input: {
  email: string;
  name: string;
  url: string;
}): Promise<void> {
  await transport.sendMail({
    from: env.SMTP_FROM,
    to: input.email,
    subject: 'Set your NIO Tech password',
    text:
      `Hello ${input.name},\n\n` +
      `An account has been created for you on NIO Tech. Choose a password to activate it:\n\n` +
      `${input.url}\n\n` +
      `This link can be used once and expires in seven days.`,
  });
}

/**
 * Notifications are deliberately dispatched after the clinical transaction commits: a mail server
 * being down must never roll back a lab result or a doctor's decision. In-app rows are written
 * first so the bell is correct even if SMTP fails.
 */
export async function dispatchNotifications(intents: NotificationIntent[]): Promise<void> {
  for (const intent of intents) {
    let notificationId: string | null = null;

    try {
      const [row] = await withTenant(intent.businessUnitId, (tx) =>
        tx
          .insert(notifications)
          .values({
            businessUnitId: intent.businessUnitId,
            userId: intent.userId,
            type: intent.type,
            title: intent.title,
            body: intent.body,
            linkPath: intent.linkPath,
            orderId: intent.orderId,
          })
          .returning({ id: notifications.id }),
      );
      notificationId = row?.id ?? null;
    } catch (error) {
      console.error('Failed to record notification', intent.type, error);
      continue;
    }

    try {
      await transport.sendMail({
        from: env.SMTP_FROM,
        to: intent.email,
        subject: intent.title,
        text: `${intent.body}\n\n${intent.linkPath ? `${env.WEB_ORIGIN}${intent.linkPath}` : ''}`.trim(),
      });

      if (notificationId) {
        await withTenant(intent.businessUnitId, (tx) =>
          tx
            .update(notifications)
            .set({ emailSentAt: new Date() })
            .where(eq(notifications.id, notificationId!)),
        );
      }
    } catch (error) {
      // Mailpit may not be running; the in-app notification already landed.
      console.warn(`Email delivery failed for ${intent.email}:`, (error as Error).message);
    }
  }
}
