import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError, z } from 'zod';
import { env } from './env.js';
import { HttpError } from './lib/errors.js';
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
import { publicRoutes } from './routes/public.js';

export async function buildApp() {
  const app = Fastify({
    // Behind nginx every request otherwise appears to come from the proxy, which would make
    // rate limiting count all clients as one and log the wrong address for every request.
    trustProxy: env.NODE_ENV === 'production',
    logger:
      env.NODE_ENV === 'test'
        ? false
        : {
            level: 'info',
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

  app.decorateRequest('actor', null);

  app.addHook('preHandler', async (request) => {
    await attachActor(request);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode;

    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message, code: error.code });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed', details: z.treeifyError(error) });
    }
    // Fastify's own client errors (payload too large, malformed JSON) are safe to pass through.
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: error.message });
    }

    request.log.error(error);
    return reply.status(500).send({ error: 'Internal server error' });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(publicRoutes);
  await app.register(platformRoutes);
  await app.register(businessUnitRoutes);
  await app.register(patientRoutes);
  await app.register(fulfillmentRoutes);
  await app.register(labRoutes);
  await app.register(doctorRoutes);
  await app.register(scanRoutes);
  await app.register(notificationRoutes);

  return app;
}
