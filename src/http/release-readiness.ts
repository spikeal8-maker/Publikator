import type { FastifyInstance } from 'fastify';
import { collectReleaseReadiness } from '../release-readiness.js';

export async function registerReleaseReadinessRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/release-readiness', async (_request, reply) => {
    try {
      return await collectReleaseReadiness();
    } catch (error) {
      app.log.error(error, 'release readiness collection failed');
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/release-readiness/report.json', async (_request, reply) => {
    try {
      const report = await collectReleaseReadiness();
      const filename = `publikator-release-readiness-${report.releaseCandidate.replace(/[^a-z0-9._-]+/gi, '-')}.json`;
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${filename}"`);
      return reply.send(`${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      app.log.error(error, 'release readiness report failed');
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
