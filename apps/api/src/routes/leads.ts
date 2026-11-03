import type { FastifyInstance } from 'fastify';
import { salesLeadSchema } from '@nio/shared';
import { env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { describeError } from '../lib/logSafe.js';
import { sendSalesLeadEmail } from '../services/notifications.js';

/** Development and test fall back to a placeholder inbox; production must configure one. */
function salesInbox(): string | null {
  if (env.SALES_LEAD_EMAIL) return env.SALES_LEAD_EMAIL;
  return env.NODE_ENV === 'production' ? null : 'sales@niotech.test';
}

/**
 * Enquiries from the static marketing site. There is no table behind this: the lead is mailed to
 * sales and nothing is stored, so the body is never logged and there is nothing to purge. The
 * route is unauthenticated, so it is rate limited per address and silently drops honeypot hits.
 */
export async function leadRoutes(app: FastifyInstance) {
  app.post(
    '/api/public/leads',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const { company_url, ...lead } = salesLeadSchema.parse(request.body);

      // Bots fill every field. Answer exactly as for a real lead so they learn nothing.
      if (company_url && company_url.trim() !== '') {
        return reply.status(202).send({ ok: true });
      }

      const to = salesInbox();
      if (!to) throw new HttpError(503, 'Enquiries are not available right now', 'LEADS_DISABLED');

      try {
        await sendSalesLeadEmail({ to, lead });
      } catch (error) {
        request.log.error({ err: describeError(error), reqId: request.id }, 'Sales lead mail failed');
        throw new HttpError(503, 'We could not send your message. Please try again.', 'LEAD_MAIL_FAILED');
      }
      return reply.status(202).send({ ok: true });
    },
  );
}
