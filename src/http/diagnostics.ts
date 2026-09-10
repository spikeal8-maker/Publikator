import type { FastifyInstance } from 'fastify';
import { collectDiagnostics } from '../diagnostics.js';

export async function registerDiagnosticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/diagnostics', async (_request, reply) => {
    try {
      return await collectDiagnostics();
    } catch (error) {
      app.log.error(error, 'diagnostics collection failed');
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
