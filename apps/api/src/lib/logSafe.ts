import { env } from '../env.js';

/**
 * Error messages from SMTP, Stripe, and Postgres drivers routinely embed recipient addresses,
 * SQL parameters, or payload fragments. In production we log only the error's class, code, and
 * HTTP status; development keeps the full error so stacks stay debuggable.
 */
export function describeError(error: unknown): unknown {
  if (env.NODE_ENV !== 'production') return error;
  const e = (error ?? {}) as { name?: unknown; code?: unknown; statusCode?: unknown };
  return {
    name: typeof e.name === 'string' ? e.name : 'Error',
    code: typeof e.code === 'string' || typeof e.code === 'number' ? e.code : undefined,
    statusCode: typeof e.statusCode === 'number' ? e.statusCode : undefined,
  };
}
