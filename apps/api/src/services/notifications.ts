import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { env } from '../env.js';
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

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: false,
  ignoreTLS: true,
});

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
