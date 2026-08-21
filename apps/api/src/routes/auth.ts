import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { devLoginSchema } from '@nio/shared';
import { authProvider, devAuthProvider } from '../auth/index.js';
import { requireActor } from '../auth/context.js';
import { withPlatformScope } from '../db/client.js';
import { platformAdmins, users } from '../db/schema.js';
import { forbidden, notFound } from '../lib/errors.js';

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/config', async () => authProvider().publicConfig());

  /**
   * Dev-only shortcut that mints a token for an already-provisioned account. It cannot create
   * accounts, so the alpha table still gates who can reach the platform admin surface.
   */
  app.post('/api/auth/dev/login', async (request) => {
    const dev = devAuthProvider();
    if (!dev) throw forbidden('Dev login is disabled when AUTH_PROVIDER=auth0');

    const { email } = devLoginSchema.parse(request.body);

    const known = await withPlatformScope(async (tx) => {
      const [admin] = await tx
        .select({ email: platformAdmins.email, name: platformAdmins.name })
        .from(platformAdmins)
        .where(eq(platformAdmins.email, email))
        .limit(1);
      if (admin) return { email: admin.email, name: admin.name ?? admin.email };

      const [user] = await tx
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return user ?? null;
    });

    if (!known) throw notFound('No account exists for that email');

    const token = await dev.issueToken({
      subject: `dev|${known.email}`,
      email: known.email,
      name: known.name,
    });

    return { accessToken: token, tokenType: 'Bearer' };
  });

  app.get('/api/auth/me', async (request) => {
    const actor = requireActor(request);
    return {
      email: actor.email,
      name: actor.name,
      userId: actor.userId,
      isPlatformAdmin: actor.isPlatformAdmin,
      memberships: actor.memberships,
    };
  });
}
