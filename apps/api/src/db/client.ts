import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

export const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  onnotice: () => {},
});

export const db = drizzle(queryClient, { schema });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Every tenant-owned table carries a `business_unit_id` and an RLS policy keyed on
 * `app.business_unit_id`. Reads and writes therefore have to happen inside a transaction
 * that has declared which tenant it is acting for; there is no ambient default.
 */
export async function withTenant<T>(businessUnitId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.business_unit_id', ${businessUnitId}, true)`);
    return fn(tx);
  });
}

/**
 * Escape hatch for the handful of code paths that legitimately span tenants: migrations,
 * seeding, and platform-superadmin endpoints. Keep the surface small and audited.
 */
export async function withPlatformScope<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_scope', 'platform', true)`);
    return fn(tx);
  });
}

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
