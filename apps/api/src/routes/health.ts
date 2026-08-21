import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    const started = Date.now();
    const [row] = await db.execute<{ ok: number }>(sql`select 1 as ok`);
    return {
      status: row?.ok === 1 ? 'ok' : 'degraded',
      database: row?.ok === 1 ? 'connected' : 'unreachable',
      latencyMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    };
  });
}
