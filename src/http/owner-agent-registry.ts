import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sessionAdmin } from '../admin-auth.js';
import { id } from '../db.js';
import {
  AgentRegistryError, controlOwnerAgent, createOwnerAgent, getOwnerAgent,
  listOwnerAgentActivity, listOwnerAgents
} from '../agent-owner-registry.js';
import { ownerMutationOriginMatches } from './security.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function apiError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({
    error: { code, message },
    requestId: id('req')
  });
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentRegistryError) {
    return apiError(reply, error.status, error.code, error.message);
  }
  throw error;
}

/**
 * Explicit local-owner barrier; never accepts machine keys, legacy admin
 * passwords, OAuth bearer tokens, or an agent authorization claim.
 * The existing browser security hook additionally enforces same-origin.
 */
async function ownerOnly(request: FastifyRequest, reply: FastifyReply) {
  if (request.headers.authorization !== undefined
    || !sessionAdmin(request.cookies?.publikator_session)) {
    return apiError(reply, 401, 'UNAUTHORIZED',
      'Для управления подключениями требуется действующая сессия владельца.');
  }
  if (MUTATING.has(request.method) && !ownerMutationOriginMatches(request)) {
    return apiError(reply, 403, 'INVALID_ORIGIN', 'Требуется корректный Origin приложения.');
  }
}

function requiredKey(request: FastifyRequest, reply: FastifyReply) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    apiError(reply, 400, 'VALIDATION_ERROR', 'Требуется заголовок Idempotency-Key.');
    return null;
  }
  return key;
}

function pagination(query: unknown): { limit: number; cursor?: string } {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Некорректный запрос.');
  }
  const input = query as Record<string, unknown>;
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || (input.cursor !== undefined && typeof input.cursor !== 'string')) {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Некорректная пагинация.');
  }
  return { limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }) };
}

export async function registerOwnerAgentRegistryRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: ownerOnly };

  app.get('/api/owner/agents', auth, async (request, reply) => {
    try {
      const { limit, cursor } = pagination(request.query);
      return listOwnerAgents(limit, cursor);
    } catch (error) { return fail(reply, error); }
  });

  app.post('/api/owner/agents', auth, async (request, reply) => {
    const key = requiredKey(request, reply);
    if (key === null) return;
    try {
      return reply.code(201).send(createOwnerAgent(request.body, key));
    } catch (error) { return fail(reply, error); }
  });

  app.get('/api/owner/agents/:agentId', auth, async (request, reply) => {
    try {
      return getOwnerAgent((request.params as { agentId: string }).agentId);
    } catch (error) { return fail(reply, error); }
  });

  app.post('/api/owner/agents/:agentId/pause', auth, async (request, reply) => {
    const key = requiredKey(request, reply);
    if (key === null) return;
    try {
      const agentId = (request.params as { agentId: string }).agentId;
      return controlOwnerAgent(agentId, 'pause', request.body, key);
    } catch (error) { return fail(reply, error); }
  });

  app.post('/api/owner/agents/:agentId/revoke', auth, async (request, reply) => {
    const key = requiredKey(request, reply);
    if (key === null) return;
    try {
      const agentId = (request.params as { agentId: string }).agentId;
      return controlOwnerAgent(agentId, 'revoke', request.body, key);
    } catch (error) { return fail(reply, error); }
  });

  app.get('/api/owner/agents/:agentId/activity', auth, async (request, reply) => {
    try {
      const agentId = (request.params as { agentId: string }).agentId;
      const { limit, cursor } = pagination(request.query);
      return listOwnerAgentActivity(agentId, limit, cursor);
    } catch (error) { return fail(reply, error); }
  });
}
