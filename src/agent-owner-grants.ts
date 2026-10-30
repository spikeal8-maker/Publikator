import { db, nowIso } from './db.js';
import { AgentRegistryError } from './agent-registry-error.js';
import {
  AGENT_PRESET_VERSION, expandsGrantPermissions, hasGrantDifference,
  normalizeOwnerGrantUpdate, type NormalizedOwnerGrant
} from './agent-grant-policy.js';
import {
  getOwnerAgent, ownerReceiptIdentity, replayOwnerResponse,
  persistOwnerResponse, recordOwnerAudit
} from './agent-owner-registry.js';

type CurrentGrant = ReturnType<typeof getOwnerAgent>['grant'];

function ensureResourcesExist(data: NormalizedOwnerGrant): void {
  const groups = [
    ['projects', data.projectIds],
    ['social_accounts', data.accountIds],
    ['ingestion_connectors', data.sourceConnectorIds]
  ] as const;
  for (const [table, ids] of groups) {
    const find = db.prepare('SELECT 1 FROM ' + table + ' WHERE id=?');
    for (const value of ids) {
      if (!find.get(value)) {
        throw new AgentRegistryError('RESOURCE_DENIED',
          'Один или несколько выбранных ресурсов отсутствуют.', 404);
      }
    }
  }
}

function changeCandidate(agentId: string, data: NormalizedOwnerGrant): {
  before: CurrentGrant; after: CurrentGrant;
  elevation: boolean; requiresOwnerConfirmation: boolean; changed: boolean
} {
  const before = getOwnerAgent(agentId).grant;
  if (before.status === 'REVOKED') {
    throw new AgentRegistryError('POLICY_DENIED',
      'Отозванное подключение нельзя повторно наделять правами.', 409);
  }
  if (before.grantVersion !== data.expectedGrantVersion) {
    throw new AgentRegistryError('STALE_GRANT_VERSION',
      'Версия разрешений изменилась. Обновите карточку бота.', 409);
  }
  ensureResourcesExist(data);
  const changed = hasGrantDifference(before, data);
  const elevation = expandsGrantPermissions(before, data);
  const after: CurrentGrant = {
    agentId, status: before.status,
    grantVersion: changed ? before.grantVersion + 1 : before.grantVersion,
    presetId: data.presetId, presetVersion: AGENT_PRESET_VERSION,
    publishMode: data.publishMode,
    scopeIds: data.scopeIds,
    projectIds: data.projectIds,
    accountIds: data.accountIds,
    sourceConnectorIds: data.sourceConnectorIds
  };
  return { before, after, changed, elevation, requiresOwnerConfirmation: elevation };
}

/** Side-effect-free preview: does not save a grant or make a publish claim. */
export function previewOwnerAgentGrant(agentId: string, input: unknown) {
  const data = normalizeOwnerGrantUpdate(input);
  const { before, after, elevation, requiresOwnerConfirmation } =
    changeCandidate(agentId, data);
  return { before, after, elevation, requiresOwnerConfirmation };
}

/** Exact, transactional owner-only grant change with immutable idempotent response. */
export function updateOwnerAgentGrant(agentId: string, input: unknown, key: string): CurrentGrant {
  const data = normalizeOwnerGrantUpdate(input);
  const operation = 'updateOwnerAgentGrant';
  // Hash only a canonical, server-validated value with sorted exact allowlists.
  const { requestId, fingerprint } = ownerReceiptIdentity(operation, key, { agentId, ...data });
  return db.transaction(() => {
    const replay = replayOwnerResponse<CurrentGrant>(operation, requestId, fingerprint);
    if (replay) return replay;
    const { before, after, elevation, changed } = changeCandidate(agentId, data);
    if (elevation && !data.confirmElevation) {
      throw new AgentRegistryError('ELEVATION_CONFIRMATION_REQUIRED',
        'Подтвердите расширение полномочий бота.', 403);
    }
    if (changed) {
      const stamp = nowIso();
      const result = db.prepare([
        'UPDATE agent_grants SET preset_id=?,preset_version=?,',
        'grant_version=grant_version+1,scope_ids_json=?,project_ids_json=?,',
        'account_ids_json=?,source_connector_ids_json=?,publish_mode=?,',
        'preapproved_policy_json=NULL,updated_at=?',
        'WHERE agent_id=? AND grant_version=?'
      ].join(' ')).run(
        after.presetId, after.presetVersion,
        JSON.stringify(after.scopeIds), JSON.stringify(after.projectIds),
        JSON.stringify(after.accountIds), JSON.stringify(after.sourceConnectorIds),
        after.publishMode, stamp, agentId, before.grantVersion
      );
      if (result.changes !== 1) {
        throw new AgentRegistryError('STALE_GRANT_VERSION',
          'Разрешения изменились параллельно.', 409);
      }
      // Existing token versions must not retain authority after an ACL edit.
      db.prepare('UPDATE agent_principals SET token_version=token_version+1,updated_at=? WHERE id=?')
        .run(stamp, agentId);
      recordOwnerAudit(agentId, requestId, fingerprint, operation,
        'POLICY_CHANGED', 'Владелец изменил разрешения бота.', after.grantVersion);
    }
    const response = changed ? getOwnerAgent(agentId).grant : before;
    persistOwnerResponse(agentId, operation, requestId, fingerprint, response);
    return response;
  }).immediate();
}
