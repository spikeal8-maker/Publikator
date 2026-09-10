import type { FastifyInstance } from 'fastify';
import { collectReleaseGate, RELEASE_PLATFORMS, setReleaseAcceptance, type ReleaseAcceptanceStatus } from '../release-gate.js';
import type { Platform } from '../db.js';

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, unknown>;
}

export async function registerReleaseGateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/release-gate', async (_request, reply) => {
    try {
      return await collectReleaseGate();
    } catch (error) {
      app.log.error(error, 'release gate collection failed');
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/api/release-gate/:platform', async (request, reply) => {
    const params = request.params as { platform: string };
    const platform = params.platform as Platform;
    if (!RELEASE_PLATFORMS.includes(platform)) return reply.code(404).send({ error: 'Площадка release gate не найдена' });

    let body: Record<string, unknown>;
    try {
      body = objectBody(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    const status = String(body.status || '').trim().toUpperCase() as ReleaseAcceptanceStatus;
    try {
      const acceptance = setReleaseAcceptance({
        platform,
        status,
        commitSha: typeof body.commitSha === 'string' ? body.commitSha : null,
        accountName: typeof body.accountName === 'string' ? body.accountName : null,
        notes: typeof body.notes === 'string' ? body.notes : null,
        confirmation: typeof body.confirmation === 'string' ? body.confirmation : null
      });
      return { ok: true, acceptance, gate: await collectReleaseGate() };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
