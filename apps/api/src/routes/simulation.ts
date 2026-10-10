import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMembership } from '../auth/context.js';
import { clearMockFlow, seedMockFlow, type SimulationOperator } from '../services/simulation.js';

const slugParam = z.object({ slug: z.string() });

export async function simulationRoutes(app: FastifyInstance) {
  function operatorFor(request: Parameters<typeof requireMembership>[0]): SimulationOperator {
    const { slug } = slugParam.parse(request.params);
    const ctx = requireMembership(request, slug, ['bu_admin']);
    return {
      businessUnitId: ctx.businessUnitId,
      businessUnitSlug: ctx.businessUnitSlug,
      userId: ctx.userId,
      actingAsPlatformAdmin: ctx.actingAsPlatformAdmin,
    };
  }

  app.post('/api/bu/:slug/simulation/seed', async (request, reply) => {
    const result = await seedMockFlow(operatorFor(request));
    return reply.status(201).send(result);
  });

  app.delete('/api/bu/:slug/simulation', async (request) => clearMockFlow(operatorFor(request)));
}
