import type { FastifyInstance } from 'fastify';
import { listPublicationUnits } from '../delivery-foundation.js';
import {
  confirmSequenceUnitNotPublished,
  confirmSequenceUnitPublished,
  continuePublicationSequence,
  retrySequenceUnit
} from '../publisher.js';
import { beginPublicationActivity } from '../runtime-gate.js';

function bodyObject(body: unknown): Record<string, any> {
  if (body == null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, any>;
}

export async function registerPublicationUnitRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/targets/:id/publication-units', async (request) => {
    const { id } = request.params as { id: string };
    return { targetId: id, units: listPublicationUnits(id) };
  });

  app.post('/api/publication-units/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return { ok: true, ...retrySequenceUnit(id) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post('/api/publication-units/:id/recovery/confirm-not-published', async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return { ok: true, ...confirmSequenceUnitNotPublished(id) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post('/api/publication-units/:id/recovery/confirm-published', async (request, reply) => {
    const { id } = request.params as { id: string };
    let body: Record<string, any>;
    try { body = bodyObject(request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    if (typeof body.externalId !== 'string' || !body.externalId.trim()) {
      return reply.code(400).send({ error: 'externalId обязателен для ручного подтверждения опубликованной Story' });
    }
    if (body.externalUrl != null && typeof body.externalUrl !== 'string') return reply.code(400).send({ error: 'externalUrl должен быть строкой или null' });
    try { return { ok: true, ...confirmSequenceUnitPublished(id, body.externalId.trim(), body.externalUrl ?? null) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post('/api/targets/:id/sequence/continue', async (request, reply) => {
    const { id } = request.params as { id: string };
    const releasePublication = beginPublicationActivity();
    try { return { ok: true, ...(await continuePublicationSequence(id)) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
    finally { releasePublication(); }
  });
}
