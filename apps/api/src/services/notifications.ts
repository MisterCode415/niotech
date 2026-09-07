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

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]!,
  );
}

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
  passwordSetUrl?: string;
  signInUrl: string;
  workspaceName?: string;
  roleLabel?: string;
}): Promise<void> {
  const assignment = input.workspaceName
    ? `${input.roleLabel ?? 'member'} of ${input.workspaceName}`
    : 'Qinio platform administrator';
  const needsActivation = Boolean(input.passwordSetUrl);

  const result = await transport.sendMail({
    from: env.SMTP_FROM,
    to: input.email,
    subject: needsActivation
      ? 'Your Qinio account is ready'
      : `You've been added to ${input.workspaceName ?? 'Qinio'}`,
    text:
      `Hello ${input.name},\n\n` +
      `You have been added as ${assignment}.\n\n` +
      (needsActivation
        ? `Set your password and activate your account:\n\n${input.passwordSetUrl}\n\n` +
          `The activation link can be used once and expires in seven days.\n\n`
        : '') +
      `Sign in here:\n\n` +
      `${input.signInUrl}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#17202a">
        <h1 style="font-size:24px">${
          needsActivation ? 'Your Qinio account is ready' : "You've been added to Qinio"
        }</h1>
        <p>Hello ${escapeHtml(input.name)},</p>
        <p>You have been added as ${escapeHtml(assignment)}.</p>
        ${
          needsActivation
            ? `<p style="margin:28px 0">
                 <a href="${escapeHtml(input.passwordSetUrl!)}"
                    style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">
                   Set password and activate account
                 </a>
               </p>
               <p style="font-size:13px;color:#5f6b76">
                 The activation link can be used once and expires in seven days.
               </p>`
            : ''
        }
        <p>${needsActivation ? 'After activation, sign in at:' : 'Sign in at:'}</p>
        <p><a href="${escapeHtml(input.signInUrl)}">${escapeHtml(input.signInUrl)}</a></p>
      </div>
    `,
  });

  // SMTP acceptance is the strongest synchronous guarantee available. Final inbox delivery,
  // bounce, and complaint events require the relay's asynchronous event feed.
  console.info(`Invitation email accepted by SMTP relay (${result.messageId})`);
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
