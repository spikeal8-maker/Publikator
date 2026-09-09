import type { FastifyInstance } from 'fastify';
import { maintenanceState } from '../runtime-gate.js';

export async function registerMaintenanceGuard(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    const state = maintenanceState();
    if (!state.active || !request.url.startsWith('/api/')) return;
    if (request.url === '/api/health' || request.url === '/api/auth/login' || request.url === '/api/auth/logout') return;
    if (request.url.startsWith('/api/backup-bundles')) return;
    return reply.code(423).send({ error: `Publikator временно заблокирован: ${state.reason || 'maintenance'}` });
  });
}
