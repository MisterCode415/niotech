/**
 * Production bootstrap. Provisions exactly one alpha superuser in the identity provider and
 * database, without adding demo tenants, fake patients, or sample orders.
 */
import { eq, ne } from 'drizzle-orm';
import { authProvider } from '../auth/index.js';
import { env } from '../env.js';
import { conflict } from '../lib/errors.js';
import { sendInvitationEmail } from '../services/notifications.js';
import { closeDb, withPlatformScope } from './client.js';
import { platformAdmins } from './schema.js';

async function main() {
  const name = 'Platform Superadmin';
  const invited = await authProvider().inviteUser({
    orgId: null,
    email: env.PLATFORM_ADMIN_EMAIL,
    name,
    loginPath: '/login',
  });

  await withPlatformScope(async (tx) => {
    const [existing] = await tx
      .select()
      .from(platformAdmins)
      .where(eq(platformAdmins.email, env.PLATFORM_ADMIN_EMAIL))
      .limit(1);

    if (existing?.auth0UserId && existing.auth0UserId !== invited.subject) {
      throw conflict(
        `Platform admin ${env.PLATFORM_ADMIN_EMAIL} is already bound to another identity`,
      );
    }

    const [admin] = await tx
      .insert(platformAdmins)
      .values({
        email: env.PLATFORM_ADMIN_EMAIL,
        auth0UserId: invited.subject,
        name,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: platformAdmins.email,
        set: { auth0UserId: invited.subject, name, isActive: true },
      })
      .returning();

    // The alpha phase deliberately has one platform root. Changing PLATFORM_ADMIN_EMAIL transfers
    // that authority instead of silently accumulating permanent superusers.
    await tx
      .update(platformAdmins)
      .set({ isActive: false })
      .where(ne(platformAdmins.id, admin!.id));

    console.log(`Platform admin ready: ${admin!.email}`);
  });

  if (invited.passwordSetUrl && invited.signInUrl) {
    await sendInvitationEmail({
      email: env.PLATFORM_ADMIN_EMAIL,
      name,
      passwordSetUrl: invited.passwordSetUrl,
      signInUrl: invited.signInUrl,
    });
    console.log(`Activation email sent to ${env.PLATFORM_ADMIN_EMAIL}`);
  } else {
    console.log(`Auth account already exists; sign in as ${env.PLATFORM_ADMIN_EMAIL}`);
  }
}

main()
  .catch((error) => {
    console.error('Bootstrap failed:', error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
