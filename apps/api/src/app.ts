import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import { ZodError, z } from 'zod';
import { env } from './env.js';
import { HttpError } from './lib/errors.js';
import { describeError } from './lib/logSafe.js';
import { attachActor } from './auth/context.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { platformRoutes } from './routes/platform.js';
import { businessUnitRoutes } from './routes/businessUnit.js';
import { patientRoutes } from './routes/patient.js';
import { fulfillmentRoutes } from './routes/fulfillment.js';
import { labRoutes } from './routes/lab.js';
import { doctorRoutes } from './routes/doctor.js';
import { scanRoutes } from './routes/scan.js';
import { notificationRoutes } from './routes/notifications.js';
import { auditRoutes } from './routes/audit.js';
import { publicRoutes } from './routes/public.js';
import { integrationRoutes } from './routes/integrations.js';
import { paymentRoutes } from './routes/payments.js';
import { stripeWebhookRoutes } from './routes/stripeWebhooks.js';
import { simulationRoutes } from './routes/simulation.js';
import { processCatalogSyncJobs, stripeEnabled } from './services/stripe.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function buildApp() {
  const app = Fastify({
    // Behind nginx every request otherwise appears to come from the proxy, which would make
    // rate limiting count all clients as one and log the wrong address for every request.
    trustProxy: env.NODE_ENV === 'production',
    // Correlate PHI access rows and log lines. A caller-supplied id is only honored when it is a
    // UUID, so the header cannot be used to inject arbitrary text into logs or the audit trail.
    genReqId: (req) => {
      const supplied = req.headers['x-request-id'];
      return typeof supplied === 'string' && UUID_PATTERN.test(supplied)
        ? supplied.toLowerCase()
        : randomUUID();
    },
    logger:
      env.NODE_ENV === 'test'
        ? false
        : {
            level: 'info',
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-qinio-integration-key"]',
                'req.headers["stripe-signature"]',
                '*.email',
              ],
              censor: '[redacted]',
            },
            serializers: {
              // Route pattern, never the raw URL: paths and query strings can carry identifiers.
              req(request) {
                return {
                  method: request.method,
                  route: request.routeOptions?.url ?? '(unmatched)',
                  id: request.id,
                };
              },
            },
            transport:
              env.NODE_ENV === 'development'
                ? {
                    target: 'pino-pretty',
                    options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
                  }
                : undefined,
          },
  });

  await app.register(cors, {
    origin: env.NODE_ENV === 'development' ? true : [env.WEB_ORIGIN],
    credentials: true,
  });

  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
  });

  app.decorateRequest('actor', null);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('preHandler', async (request) => {
    await attachActor(request);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode;

    if (error instanceof HttpError) {
      return reply
        .status(error.statusCode)
        .send({ error: error.message, code: error.code, details: error.details });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed', details: z.treeifyError(error) });
    }
    // Fastify's own client errors (payload too large, malformed JSON) are safe to pass through.
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: error.message });
    }

    request.log.error({ err: describeError(error), reqId: request.id }, 'Unhandled request error');
    return reply.status(500).send({ error: 'Internal server error' });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(publicRoutes);
  await app.register(integrationRoutes);
  await app.register(stripeWebhookRoutes);
  await app.register(paymentRoutes);
  await app.register(platformRoutes);
  await app.register(businessUnitRoutes);
  await app.register(patientRoutes);
  await app.register(fulfillmentRoutes);
  await app.register(labRoutes);
  await app.register(doctorRoutes);
  await app.register(scanRoutes);
  await app.register(auditRoutes);
  await app.register(notificationRoutes);
  await app.register(simulationRoutes);

  if (stripeEnabled()) {
    const catalogTimer = setInterval(() => {
      void processCatalogSyncJobs().catch((error) =>
        app.log.error({ err: describeError(error) }, 'Catalog sync job failed'),
      );
    }, 60_000);
    catalogTimer.unref();
    app.addHook('onClose', async () => clearInterval(catalogTimer));
  }

  return app;
}
