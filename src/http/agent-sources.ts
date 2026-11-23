import type { FastifyInstance, FastifyReply } from 'fastify';
import { db, id } from '../db.js';
import { getOwnerAgent } from '../agent-owner-registry.js';
import { AgentRegistryError } from '../agent-registry-error.js';
import { normalizeRelativePath } from '../cloud-media-reference.js';
import { decryptJson, encryptJson } from '../crypto.js';
import { listGoogleDriveFolder } from '../google-drive-media.js';
import { listYandexDiskFolder } from '../yandex-disk-media.js';
import { assertEffectiveAgentGrant, type VerifiedAgentIdentity } from '../agent-grant-acl.js';
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

export function listScopedAgentSources(getPrincipal: () => VerifiedAgentIdentity, page: Page) {
  return db.transaction(() => {
    const principal = getPrincipal();
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
      return listScopedAgentSources(() => verifiedAgentBearer(request), parsePage(request.query));
    } catch (error) {
      return safeError(reply, error);
    }
  });
}

type MediaConnector = { type: 'google_drive' | 'yandex_disk'; config_json: string; credentials_encrypted: string; updated_at: string };
type FolderPage = { items: Array<{ relativePath: string; isDirectory: boolean; mimeType: string | null; sizeBytes: number; modifiedAt: string | null }>; nextCursor: string | null };
type FolderCursor = { agentId: string; grantVersion: number; connectorId: string; folder: string; providerCursor: string; until: number };

export async function listScopedMediaFiles(identity: VerifiedAgentIdentity, connectorId: string, requestedFolder: string, cursor?: string) {
  let folder: string;
  let page: string | undefined;
  try {
    folder = requestedFolder ? normalizeRelativePath(requestedFolder) : '';
    if (folder.includes('%')) throw new Error('encoded folder');
    if (cursor) {
      const data = decryptJson<FolderCursor>(cursor);
      if (data.agentId !== identity.agentId || data.grantVersion !== identity.grantVersion
        || data.connectorId !== connectorId || data.folder !== folder || data.until <= Date.now()) {
        throw new Error('expired or unrelated cursor');
      }
      page = data.providerCursor;
    }
  } catch {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Путь к папке или курсор недействительны.', 400);
  }

  function authorizedConnector(): MediaConnector {
    return db.transaction(() => {
      assertEffectiveAgentGrant({ ...identity, requiredScope: 'sources:read', sourceConnectorId: connectorId });
      const connector = db.prepare(`SELECT type,config_json,credentials_encrypted,updated_at FROM ingestion_connectors
        WHERE id=? AND enabled=1 AND type IN ('google_drive','yandex_disk')`).get(connectorId) as MediaConnector | undefined;
      if (!connector) throw new AgentRegistryError('RESOURCE_DENIED', 'Источник медиа недоступен.', 403);
      return connector;
    })();
  }

  const connector = authorizedConnector();
  let listing: FolderPage;
  try {
    listing = await (connector.type === 'google_drive'
      ? listGoogleDriveFolder(connectorId, folder, page)
      : listYandexDiskFolder(connectorId, folder, page));
  } catch {
    throw new AgentRegistryError('MEDIA_SOURCE_UNAVAILABLE', 'Папку не удалось открыть. Проверьте путь и доступ к источнику.', 422);
  }
  if (JSON.stringify(connector) !== JSON.stringify(authorizedConnector())) {
    throw new AgentRegistryError('SOURCE_CHANGED', 'Подключение источника изменилось. Откройте папку снова.', 409);
  }

  const items = listing.items
    .filter((item) => item.isDirectory || item.mimeType?.startsWith('image/') || item.mimeType === 'video/mp4')
    .map(({ relativePath, isDirectory, mimeType, sizeBytes, modifiedAt }) =>
      ({ relativePath, isDirectory, mimeType, sizeBytes, modifiedAt }));
  const nextCursor = listing.nextCursor ? encryptJson({
    agentId: identity.agentId, grantVersion: identity.grantVersion, connectorId, folder,
    providerCursor: listing.nextCursor, until: Date.now() + 20 * 60 * 1000,
  } satisfies FolderCursor) : null;
  return { connectorId, folder, items, nextCursor };
}
