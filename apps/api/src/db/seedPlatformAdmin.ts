/**
 * Production bootstrap. Creates the alpha superuser row and nothing else, so a deployed
 * environment never gains the demo tenants, fake patients, or sample orders that seed.ts inserts.
 */
import { env } from '../env.js';
import { closeDb, withPlatformScope } from './client.js';
import { platformAdmins } from './schema.js';

async function main() {
  await withPlatformScope(async (tx) => {
    const [admin] = await tx
      .insert(platformAdmins)
      .values({ email: env.PLATFORM_ADMIN_EMAIL, name: 'Platform Superadmin', isActive: true })
      .onConflictDoUpdate({ target: platformAdmins.email, set: { isActive: true } })
      .returning();

    console.log(`Platform admin ready: ${admin!.email}`);
  });

  console.log(
    'Sign in with that email, then create the first business unit from the platform dashboard.',
  );
}

main()
  .catch((error) => {
    console.error('Bootstrap failed:', error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
