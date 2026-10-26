import type { FastifyInstance, FastifyReply } from 'fastify';
import { db, id } from '../db.js';
import { getOwnerAgent } from '../agent-owner-registry.js';
import { AgentBearerFailure, respondAgentBearerFailure, verifiedAgentBearer } from './agent-bearer-boundary.js';

const NON_EXECUTABLE_MACHINE_SCOPES = new Set([
  'publish:request', 'schedule:write', 'jobs:read', 'events:read'
]);

function safeIds(table: 'projects' | 'social_accounts' | 'ingestion_connectors',
  scopeAllowed: boolean, ids: string[]): string[] {
  if (!scopeAllowed) return [];
  // Both table name and owner-issued IDs originate from trusted validated
  // internal state, never from arbitrary request/path query strings.
  const check = db.prepare('SELECT 1 FROM ' + table + ' WHERE id=?');
  return ids.filter(value => check.get(value) !== undefined).sort();
}

function capabilitiesFromVerifiedMachine(request: Parameters<typeof verifiedAgentBearer>[0]) {
  // Recheck the live token after onRequest, then read the grant in one
  // immediate SQLite snapshot. Do not trust model-provided agentId or scopes.
  return db.transaction(() => {
    const agent = verifiedAgentBearer(request);
    const current = getOwnerAgent(agent.agentId).grant;
    if (current.grantVersion !== agent.grantVersion || current.status !== 'ACTIVE') {
      throw new AgentBearerFailure(401, 'UNAUTHORIZED', 'Разрешения агента устарели.');
    }
    const permitted = new Set(agent.tokenScopes);
    const scopeIds = current.scopeIds.filter(s =>
      permitted.has(s) && !NON_EXECUTABLE_MACHINE_SCOPES.has(s)
    ).sort();
    return {
      agentId: agent.agentId,
      presetId: current.presetId,
      // Machine clients have no execution-time owner consent in this stage.
      publishMode: 'DRAFT_ONLY' as const,
      grantVersion: current.grantVersion,
      scopeIds,
      projectIds: safeIds('projects', scopeIds.includes('projects:read'), current.projectIds),
      accountIds: safeIds('social_accounts', scopeIds.includes('accounts:read'), current.accountIds),
      sourceConnectorIds: safeIds('ingestion_connectors', scopeIds.includes('sources:read'),
        current.sourceConnectorIds),
      blockedReasons: [
        'ONLY_PROJECT_AND_ACCOUNT_LIST_READ_ENABLED',
        'MACHINE_KEYS_CANNOT_PUBLISH_OR_SCHEDULE',
        'MCP_AND_OAUTH_NOT_YET_ENABLED'
      ]
    };
  }).immediate();
}

function malformedQuery(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: 'VALIDATION_ERROR', message: 'Этот маршрут не принимает параметры URL.' },
    requestId: id('req'),
    retryable: false
  });
}

/** First live Agent API route: capabilities only, no resource data or writes. */
export async function registerAgentMachineReadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/v1/capabilities', async (request, reply) => {
    if (request.url.includes('?')) return malformedQuery(reply);
    try {
      return capabilitiesFromVerifiedMachine(request);
    } catch (error) {
      return respondAgentBearerFailure(reply, error);
    }
  });
}
