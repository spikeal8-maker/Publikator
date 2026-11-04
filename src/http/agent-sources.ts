import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, id } from '../db.js';
import { getOwnerAgent } from '../agent-owner-registry.js';
import { AgentRegistryError } from '../agent-registry-error.js';
import { assertEffectiveAgentGrant } from '../agent-grant-acl.js';
import { parsePage, IDENTIFIER, type Page } from './agent-page.js';
import {
  AgentBearerFailure, respondAgentBearerFailure, verifiedAgentBearer
} from './agent-bearer-boundary.js';

type SourceType = 'google_drive' | 'google_sheets' | 'yandex_disk' | 'generic_https';
const KNOWN_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'google_drive','google_sheets','yandex_disk','generic_https'
]);
type SourceRow = {
  id: string; type: string; name: string; enabled: number;
};

function scopedSources(request: FastifyRequest, page: Page) {
  return db.transaction(() => {
    const principal = verifiedAgentBearer(request);
    const grant = getOwnerAgent(principal.agentId).grant;
    if (grant.status !== 'ACTIVE' || grant.grantVersion !== principal.grantVersion) {
      throw new AgentBearerFailure(401, 'UNAUTHORIZED', 'Разрешения источников устарели.');
    }
    if (!principal.tokenScopes.includes('sources:read')
      || !grant.scopeIds.includes('sources:read')) {
      throw new AgentRegistryError('FORBIDDEN_SCOPE',
        'Нет разрешения на просмотр источников.', 403);
    }
    const ids = [...new Set(grant.sourceConnectorIds.filter(x => IDENTIFIER.test(x)))];
    if (!ids.length) {
      return { items: [], pagination: { limit: page.limit, nextCursor: null } };
    }
    // A connector's config_json can contain filesystem paths, folder roots,
    // destination IDs or accidentally persisted secrets; credentials_encrypted
    // must never enter this query or serialized response. All filters run
    // server-side and use bound SQL placeholders, not generated SQL values.
    const sql = [
      'SELECT id,type,name,enabled FROM ingestion_connectors',
      'WHERE id IN (' + ids.map(() => '?').join(',') + ') AND id>?',
      'ORDER BY id LIMIT ?'
    ].join(' ');
    const rows = db.prepare(sql).all(...ids, page.after, page.limit + 1) as SourceRow[];
    const visible = rows.slice(0, page.limit);
    for (const row of visible) {
      assertEffectiveAgentGrant({
        agentId: principal.agentId,
        tokenVersion: principal.tokenVersion,
        grantVersion: principal.grantVersion,
        tokenScopes: principal.tokenScopes,
        requiredScope: 'sources:read',
        sourceConnectorId: row.id
      });
      if (!KNOWN_SOURCE_TYPES.has(row.type)) {
        throw new AgentRegistryError('RESOURCE_DENIED',
          'Неизвестный тип источника.', 403);
      }
    }
    return {
      items: visible.map(row => ({
        id: row.id,
        type: row.type as SourceType,
        name: row.name.slice(0,160),
        enabled: row.enabled === 1
      })),
      pagination: {
        limit: page.limit,
        nextCursor: rows.length > page.limit
          ? Buffer.from(visible.at(-1)!.id).toString('base64url') : null
      }
    };
  })();
}

function safeError(reply: FastifyReply, error: unknown) {
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

/** A2a3: only safe source metadata. No connector config or file access. */
export async function registerAgentSourceReadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/v1/sources', async (request, reply) => {
    try {
      return scopedSources(request, parsePage(request.query));
    } catch (error) {
      return safeError(reply, error);
    }
  });
}
