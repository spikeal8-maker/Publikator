import type { FastifyInstance } from 'fastify';
import { beginRuntimeActivity, maintenanceState } from '../runtime-gate.js';

function exemptFromRuntimeGate(url: string): boolean {
  return url === '/api/health' || url === '/api/auth/login' || url === '/api/auth/logout' || url.startsWith('/api/backup-bundles');
}

export async function registerMaintenanceGuard(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/') || exemptFromRuntimeGate(request.url)) return;

    const state = maintenanceState();
    if (state.active) return reply.code(423).send({ error: `Publikator временно заблокирован: ${state.reason || 'maintenance'}` });

    let release: () => void;
    try {
      release = beginRuntimeActivity();
    } catch (error) {
      return reply.code(423).send({ error: error instanceof Error ? error.message : String(error) });
    }
    reply.raw.once('finish', release);
    reply.raw.once('close', release);
  });
}
