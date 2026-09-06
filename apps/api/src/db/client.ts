import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { ActorRole } from '@nio/shared';
import { env } from '../env.js';
import * as schema from './schema.js';

export const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  onnotice: () => {},
});

export const db = drizzle(queryClient, { schema });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface TenantDatabaseContext {
  businessUnitId: string;
  userId: string;
  actorRole: ActorRole;
}

/**
 * Every tenant-owned table carries a `business_unit_id` and an RLS policy keyed on
 * transaction-local tenant, user, and role settings. Passing only an id is reserved for trusted
 * server work (public catalog reads and post-commit notifications); request handlers pass their
 * authenticated TenantContext so role-aware policies can enforce the same boundary as the API.
 */
export async function withTenant<T>(
  scope: string | TenantDatabaseContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const context =
    typeof scope === 'string'
      ? { businessUnitId: scope, userId: '', actorRole: 'system' as const }
      : scope;

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.business_unit_id', ${context.businessUnitId}, true),
        set_config('app.user_id', ${context.userId}, true),
        set_config('app.actor_role', ${context.actorRole}, true),
        set_config('app.tenant_scope', '', true)
    `);
    return fn(tx);
  });
}

/**
 * Escape hatch for the handful of code paths that legitimately span tenants: migrations,
 * seeding, and platform-superadmin endpoints. Keep the surface small and audited.
 */
export async function withPlatformScope<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.tenant_scope', 'platform', true),
        set_config('app.business_unit_id', '', true),
        set_config('app.user_id', '', true),
        set_config('app.actor_role', 'platform_admin', true)
    `);
    return fn(tx);
  });
}

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
