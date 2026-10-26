import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { id } from '../db.js';
import {
  authenticateAgentMachineKey, type VerifiedMachineKey
} from '../agent-machine-keys.js';
import { ownerMutationOriginMatches } from './security.js';

const PREFIX = '/api/agent/v1';
const STRICT_BEARER = /^Bearer (pak1_[A-Za-z0-9_-]{43})$/i;

/**
 * This path class is authenticated by an onRequest hook registered before
 * the existing cookie preHandler. Do not exempt another path or insert an
 * unauthenticated whitelist entry.
 */
export function isAgentApiPath(url: string): boolean {
  const pathname = url.split(/[?#]/, 1)[0] ?? '';
  return pathname === PREFIX || pathname.startsWith(PREFIX + '/');
}

function failure(reply: FastifyReply, status: number, code: string, message: string) {
  if (status === 401) {
    reply.header('www-authenticate', 'Bearer realm="publikator-agent", error="invalid_token"');
  }
  return reply.code(status).send({
    error: { code, message },
    requestId: id('req'),
    retryable: false
  });
}

/**
 * Every request (including unknown agent paths and unsupported methods)
 * requires one standalone machine Bearer and no browser cookie or legacy key.
 * For requests with Origin, enforce the exact configured public origin; an
 * Origin-less headless client is allowed with a valid machine Bearer.
 */
export function verifiedAgentBearer(request: FastifyRequest): VerifiedMachineKey {
  if (request.headers.cookie !== undefined
    || request.headers['x-api-key'] !== undefined
    || request.headers['x-integration-key'] !== undefined) {
    throw new AgentBearerFailure(401, 'UNAUTHORIZED',
      'Машинные ключи и административные сессии не смешиваются.');
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !ownerMutationOriginMatches(request)) {
    throw new AgentBearerFailure(403, 'INVALID_ORIGIN',
      'Недопустимый Origin для запроса агента.');
  }
  const raw = request.headers.authorization;
  const match = typeof raw === 'string' ? STRICT_BEARER.exec(raw) : null;
  if (!match) {
    throw new AgentBearerFailure(401, 'UNAUTHORIZED',
      'Требуется действующий отдельный Bearer машинного агента.');
  }
  try {
    return authenticateAgentMachineKey(match[1]);
  } catch {
    // Never reflect token contents, schema internals, or DB failures.
    throw new AgentBearerFailure(401, 'UNAUTHORIZED',
      'Машинный ключ недействителен, истёк или отозван.');
  }
}

export class AgentBearerFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: 'UNAUTHORIZED' | 'INVALID_ORIGIN',
    message: string
  ) { super(message); }
}

export function respondAgentBearerFailure(reply: FastifyReply, e: unknown) {
  if (e instanceof AgentBearerFailure) {
    return failure(reply, e.status, e.code, e.message);
  }
  // Never return raw DB/credential errors to an untrusted caller.
  return failure(reply, 401, 'UNAUTHORIZED', 'Не удалось проверить машинный ключ.');
}

/**
 * Globally scoped hook covers every /api/agent/v1 path. This MUST register
 * before registerRoutes() creates its single-owner cookie preHandler.
 */
export async function registerAgentBearerBoundary(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (!isAgentApiPath(request.url)) return;
    try {
      verifiedAgentBearer(request);
    } catch (error) {
      return respondAgentBearerFailure(reply, error);
    }
  });
}
