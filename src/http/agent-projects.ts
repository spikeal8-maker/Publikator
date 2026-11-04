import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, id } from '../db.js';
import { getOwnerAgent } from '../agent-owner-registry.js';
import { AgentRegistryError } from '../agent-registry-error.js';
import { assertEffectiveAgentGrant } from '../agent-grant-acl.js';
import {
  AgentBearerFailure, respondAgentBearerFailure, verifiedAgentBearer
} from './agent-bearer-boundary.js';

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
type Page = { limit: number; after: string };

function invalidPage(message: string): never {
  throw new AgentRegistryError('VALIDATION_ERROR', message, 400);
}

function parsePage(query: unknown): Page {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    invalidPage('Некорректные параметры списка.');
  }
  const params = query as Record<string, unknown>;
  if (Object.keys(params).some(k => k !== 'limit' && k !== 'cursor')) {
    invalidPage('Допустимы только limit и cursor.');
  }
  let limit = 50;
  if (params.limit !== undefined) {
    const raw = params.limit;
    if (typeof raw !== 'string' || !/^[1-9]\d{0,2}$/.test(raw)
      || Number(raw) > 100) {
      invalidPage('Допустимый limit: от 1 до 100.');
    }
    limit = Number(raw);
  }
  let after = '';
  if (params.cursor !== undefined) {
    if (typeof params.cursor !== 'string'
      || !/^[A-Za-z0-9_-]{1,512}$/.test(params.cursor)) {
      invalidPage('Некорректный cursor.');
    }
    const decoded = Buffer.from(params.cursor, 'base64url').toString('utf8');
    if (!IDENTIFIER.test(decoded)
      || Buffer.from(decoded, 'utf8').toString('base64url') !== params.cursor) {
      invalidPage('Некорректный cursor.');
    }
    after = decoded;
  }
  return { limit, after };
}

function listVerifiedProjects(request: FastifyRequest, page: Page) {
  // One read-only SQLite snapshot. The identity comes from a fresh validated
  // machine token, never from an agent/model-supplied ID or query field.
  return db.transaction(() => {
    const principal = verifiedAgentBearer(request);
    const grant = getOwnerAgent(principal.agentId).grant;
    if (grant.status !== 'ACTIVE' || grant.grantVersion !== principal.grantVersion) {
      throw new AgentBearerFailure(401, 'UNAUTHORIZED', 'Разрешения были изменены.');
    }
    if (!principal.tokenScopes.includes('projects:read')
      || !grant.scopeIds.includes('projects:read')) {
      throw new AgentRegistryError('FORBIDDEN_SCOPE', 'Недостаточно прав для просмотра проектов.', 403);
    }
    const allowlist = [...new Set(grant.projectIds.filter(x => IDENTIFIER.test(x)))];
    if (allowlist.length === 0) {
      return { items: [], pagination: { limit: page.limit, nextCursor: null } };
    }
    // All data filtering occurs in SQL, before serialization. The only
    // generated query text is a count of SQL placeholders; IDs are bound.
    const placeholders = allowlist.map(() => '?').join(',');
    const query = [
      'SELECT id,name,default_timezone FROM projects',
      'WHERE id IN (' + placeholders + ') AND id > ?',
      'ORDER BY id LIMIT ?'
    ].join(' ');
    const records = db.prepare(query).all(...allowlist, page.after, page.limit + 1) as
      Array<{ id: string; name: string; default_timezone: string }>;
    const visible = records.slice(0, page.limit);
    for (const item of visible) {
      assertEffectiveAgentGrant({
        agentId: principal.agentId,
        tokenVersion: principal.tokenVersion,
        grantVersion: principal.grantVersion,
        tokenScopes: principal.tokenScopes,
        requiredScope: 'projects:read',
        projectId: item.id
      });
    }
    return {
      items: visible.map(row => ({
        id: row.id,
        name: row.name.slice(0, 160),
        defaultTimezone: row.default_timezone.slice(0, 80)
      })),
      pagination: {
        limit: page.limit,
        nextCursor: records.length > page.limit
          ? Buffer.from(visible.at(-1)!.id).toString('base64url') : null
      }
    };
  })();
}

function safeReadFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentRegistryError && (
    error.code === 'VALIDATION_ERROR' || error.code === 'FORBIDDEN_SCOPE'
    || error.code === 'RESOURCE_DENIED'
  )) {
    return reply.code(error.status).send({
      error: { code: error.code, message: error.message },
      requestId: id('req'), retryable: false
    });
  }
  return respondAgentBearerFailure(reply, error);
}

/** AGENT-A2a1: list ONLY the exact owner-granted projects. No broad fallback. */
export async function registerAgentProjectReadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/v1/projects', async (request, reply) => {
    try {
      const page = parsePage(request.query);
      return listVerifiedProjects(request, page);
    } catch (error) {
      return safeReadFailure(reply, error);
    }
  });
}
