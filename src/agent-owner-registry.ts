import crypto from 'node:crypto';
import { db, id, nowIso } from './db.js';

const CLIENT_KINDS = new Set([
  'chatgpt', 'codex', 'claude', 'cursor', 'n8n', 'telegram_bot',
  'max_bot', 'custom_mcp', 'rest_client'
]);
const AGENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

type StoredAgent = {
  id: string;
  name: string;
  client_kind: string;
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  created_at: string;
  last_used_at: string | null;
  grant_version: number;
  preset_id: string;
  preset_version: number;
  publish_mode: string;
  scope_ids_json: string;
  project_ids_json: string;
  account_ids_json: string;
  source_connector_ids_json: string;
  preapproved_policy_json: string | null;
};

const SELECT_AGENT = [
  'SELECT p.id,p.name,p.client_kind,p.status,p.created_at,p.last_used_at,',
  'g.grant_version,g.preset_id,g.preset_version,g.publish_mode,',
  'g.scope_ids_json,g.project_ids_json,g.account_ids_json,',
  'g.source_connector_ids_json,g.preapproved_policy_json',
  'FROM agent_principals p JOIN agent_grants g ON g.agent_id=p.id'
].join(' ');

export class AgentRegistryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400
  ) { super(message); }
}

function assertAgentId(agentId: string): void {
  if (!AGENT_ID.test(agentId)) {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Некорректный идентификатор бота.');
  }
}

function jsonArray(value: string): string[] {
  return JSON.parse(value) as string[];
}

function publicAgent(row: StoredAgent) {
  const grant = {
    agentId: row.id,
    grantVersion: row.grant_version,
    presetId: row.preset_id,
    presetVersion: row.preset_version,
    publishMode: row.publish_mode,
    scopeIds: jsonArray(row.scope_ids_json),
    projectIds: jsonArray(row.project_ids_json),
    accountIds: jsonArray(row.account_ids_json),
    sourceConnectorIds: jsonArray(row.source_connector_ids_json),
    status: row.status,
    ...(row.preapproved_policy_json === null
      ? {} : { preapprovedPolicy: JSON.parse(row.preapproved_policy_json) })
  };
  return {
    agentId: row.id, name: row.name, clientKind: row.client_kind,
    status: row.status, grant,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {})
  };
}

export function getOwnerAgent(agentId: string) {
  assertAgentId(agentId);
  const row = db.prepare(SELECT_AGENT + ' WHERE p.id=?').get(agentId) as StoredAgent | undefined;
  if (!row) throw new AgentRegistryError('RESOURCE_NOT_FOUND', 'Бот не найден.', 404);
  return publicAgent(row);
}

export function listOwnerAgents(limit: number, cursor?: string) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Допустимый limit: 1–100.');
  }
  let where = '';
  const params: Array<string | number> = [];
  if (cursor !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
      throw new AgentRegistryError('VALIDATION_ERROR', 'Некорректный cursor.');
    }
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 2 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parts[0] ?? '')
      || !AGENT_ID.test(parts[1] ?? '')
      || Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
      throw new AgentRegistryError('VALIDATION_ERROR', 'Некорректный cursor.');
    }
    where = ' WHERE (p.created_at < ? OR (p.created_at = ? AND p.id < ?))';
    params.push(parts[0]!, parts[0]!, parts[1]!);
  }
  const rows = db.prepare(SELECT_AGENT + where + ' ORDER BY p.created_at DESC,p.id DESC LIMIT ?')
    .all(...params, limit + 1) as StoredAgent[];
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  const nextCursor = rows.length > limit && last
    ? Buffer.from(last.created_at + '|' + last.id).toString('base64url') : null;
  return { items: visible.map(publicAgent), pagination: { limit, nextCursor } };
}

function safeCreateInput(value: unknown): { name: string; clientKind: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Ожидается JSON-объект.');
  }
  const input = value as Record<string, unknown>;
  const known = new Set([
    'name', 'clientKind', 'presetId', 'publishMode', 'scopeIds', 'projectIds',
    'accountIds', 'sourceConnectorIds', 'confirmElevation'
  ]);
  if (Object.keys(input).some(key => !known.has(key))) {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Неизвестные поля подключения.');
  }
  if (typeof input.name !== 'string') {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Укажите название бота.');
  }
  const name = input.name.trim().normalize('NFKC');
  if (name.length < 1 || name.length > 160 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Название бота: от 1 до 160 символов.');
  }
  if (typeof input.clientKind !== 'string' || !CLIENT_KINDS.has(input.clientKind)) {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Неизвестный тип клиента.');
  }
  if ((input.presetId !== undefined && input.presetId !== 'OBSERVER')
    || (input.publishMode !== undefined && input.publishMode !== 'DRAFT_ONLY')
    || (input.confirmElevation !== undefined && input.confirmElevation !== false)
    || ['scopeIds', 'projectIds', 'accountIds', 'sourceConnectorIds'].some(
      key => input[key] !== undefined && (!Array.isArray(input[key]) || (input[key] as unknown[]).length !== 0)
    )) {
    throw new AgentRegistryError('POLICY_DENIED',
      'Первичная регистрация допускает только OBSERVER, DRAFT_ONLY и пустые списки. Назначение прав выполняется отдельно.', 403);
  }
  return { name, clientKind: input.clientKind };
}

function receipt(operation: string, key: string, payload: unknown) {
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Требуется корректный Idempotency-Key.');
  }
  const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
  return {
    requestId: 'req_' + hash('OWNER\0' + operation + '\0' + key),
    fingerprint: hash(JSON.stringify(payload))
  };
}

function replayResult<T extends object>(
  operation: string, requestId: string, fingerprint: string
): T | null {
  const previous = db.prepare([
    'SELECT operation_id,request_hash,response_json',
    'FROM agent_owner_operation_receipts WHERE request_id=?'
  ].join(' ')).get(requestId) as {
    operation_id: string; request_hash: string; response_json: string
  } | undefined;
  if (!previous) return null;
  if (previous.operation_id !== operation || previous.request_hash !== fingerprint) {
    throw new AgentRegistryError('IDEMPOTENCY_CONFLICT',
      'Ключ уже использован с другим содержимым.', 409);
  }
  return JSON.parse(previous.response_json) as T;
}

function saveReceipt(
  agentId: string, operation: string, requestId: string,
  fingerprint: string, response: object
): void {
  db.prepare([
    'INSERT INTO agent_owner_operation_receipts',
    '(request_id,agent_id,operation_id,request_hash,response_json,created_at)',
    'VALUES (?,?,?,?,?,?)'
  ].join(' ')).run(
    requestId, agentId, operation, fingerprint, JSON.stringify(response), nowIso()
  );
}

function audit(
  agentId: string, requestId: string, fingerprint: string, operation: string,
  stage: 'COMPLETED' | 'PAUSED' | 'REVOKED', summary: string, grantVersion: number
) {
  db.prepare([
    'INSERT INTO agent_activity_events',
    '(event_id,agent_id,actor_type,origin,request_id,correlation_id,',
    'operation_id,stage,outcome,safe_summary,grant_version,occurred_at)',
    'VALUES (?,?,' + "'OWNER','UI'" + ',?,?,?,?,' + "'SUCCEEDED'" + ',?,?,?)'
  ].join(' ')).run(
    id('evt'), agentId, requestId, fingerprint, operation, stage,
    summary, grantVersion, nowIso()
  );
}

export function createOwnerAgent(input: unknown, key: string) {
  const data = safeCreateInput(input);
  const operation = 'createOwnerAgent';
  const { requestId, fingerprint } = receipt(operation, key, data);
  return db.transaction(() => {
    const replay = replayResult<ReturnType<typeof getOwnerAgent>>(operation, requestId, fingerprint);
    if (replay) return replay;
    const agentId = id('agent');
    const timestamp = nowIso();
    db.prepare([
      'INSERT INTO agent_principals(id,owner_admin_id,name,client_kind,created_at,updated_at)',
      "VALUES (?,'owner',?,?,?,?)"
    ].join(' ')).run(agentId, data.name, data.clientKind, timestamp, timestamp);
    db.prepare('INSERT INTO agent_grants(agent_id,created_at,updated_at) VALUES (?,?,?)')
      .run(agentId, timestamp, timestamp);
    audit(agentId, requestId, fingerprint, operation, 'COMPLETED',
      'Владелец создал подключение без разрешённых ресурсов.', 1);
    const response = getOwnerAgent(agentId);
    saveReceipt(agentId, operation, requestId, fingerprint, response);
    return response;
  }).immediate();
}

export function controlOwnerAgent(
  agentId: string, action: 'pause' | 'revoke', body: unknown, key: string
) {
  assertAgentId(agentId);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Ожидается JSON-объект.');
  }
  const data = body as Record<string, unknown>;
  if (Object.keys(data).some(key => !['expectedGrantVersion', 'confirm'].includes(key))
    || !Number.isSafeInteger(data.expectedGrantVersion)
    || Number(data.expectedGrantVersion) < 1 || data.confirm !== true) {
    throw new AgentRegistryError('VALIDATION_ERROR',
      'Необходимы expectedGrantVersion и явное confirm=true.');
  }
  const operation = action === 'pause' ? 'pauseOwnerAgent' : 'revokeOwnerAgent';
  const { requestId, fingerprint } = receipt(operation, key, { agentId, action, expectedGrantVersion: data.expectedGrantVersion, confirm: true });
  return db.transaction(() => {
    const replay = replayResult<ReturnType<typeof getOwnerAgent>['grant']>(operation, requestId, fingerprint);
    if (replay) return replay.grant;
    const row = db.prepare([
      'SELECT p.status,g.grant_version FROM agent_principals p',
      'JOIN agent_grants g ON g.agent_id=p.id WHERE p.id=?'
    ].join(' ')).get(agentId) as {
      status: 'ACTIVE' | 'PAUSED' | 'REVOKED'; grant_version: number
    } | undefined;
    if (!row) throw new AgentRegistryError('RESOURCE_NOT_FOUND', 'Бот не найден.', 404);
    if (row.grant_version !== data.expectedGrantVersion) {
      throw new AgentRegistryError('STALE_GRANT_VERSION', 'Версия разрешений изменилась.', 409);
    }
    if (row.status === 'REVOKED' || (action === 'pause' && row.status !== 'ACTIVE')) {
      throw new AgentRegistryError('POLICY_DENIED', 'Недопустимое изменение статуса.', 409);
    }
    const status = action === 'pause' ? 'PAUSED' : 'REVOKED';
    const timestamp = nowIso();
    db.prepare('UPDATE agent_principals SET status=?,token_version=token_version+1,updated_at=? WHERE id=?')
      .run(status, timestamp, agentId);
    db.prepare('UPDATE agent_grants SET grant_version=grant_version+1,updated_at=? WHERE agent_id=?')
      .run(timestamp, agentId);
    audit(agentId, requestId, fingerprint, operation, status,
      status === 'PAUSED' ? 'Владелец приостановил подключение.' : 'Владелец отозвал подключение.',
      row.grant_version + 1);
    const response = getOwnerAgent(agentId).grant;
    saveReceipt(agentId, operation, requestId, fingerprint, response);
    return response;
  }).immediate();
}

type StoredActivity = {
  sequence: number; event_id: string; agent_id: string; actor_type: string;
  origin: string; request_id: string; operation_id: string;
  stage: string; outcome: string | null; safe_summary: string;
  occurred_at: string; grant_version: number | null
};

export function listOwnerAgentActivity(agentId: string, limit: number, cursor?: string) {
  assertAgentId(agentId);
  getOwnerAgent(agentId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || (cursor !== undefined && (!/^[1-9]\d{0,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))) {
    throw new AgentRegistryError('VALIDATION_ERROR', 'Некорректные параметры журнала.');
  }
  const rows = db.prepare([
    'SELECT sequence,event_id,agent_id,actor_type,origin,request_id,operation_id,',
    'stage,outcome,safe_summary,occurred_at,grant_version FROM agent_activity_events',
    'WHERE agent_id=?' + (cursor ? ' AND sequence<?' : ''),
    'ORDER BY sequence DESC LIMIT ?'
  ].join(' ')).all(...(cursor ? [agentId, Number(cursor), limit + 1] : [agentId, limit + 1])) as StoredActivity[];
  const visible = rows.slice(0, limit);
  return {
    items: visible.map(r => ({
      schemaVersion: 1 as const, eventId: r.event_id, sequence: r.sequence,
      occurredAtUtc: r.occurred_at, actorType: r.actor_type,
      agentId: r.agent_id, origin: r.origin, requestId: r.request_id,
      operationId: r.operation_id, stage: r.stage, safeSummary: r.safe_summary,
      ...(r.outcome ? { outcome: r.outcome } : {}),
      ...(r.grant_version ? { grantVersion: r.grant_version } : {})
    })),
    pagination: {
      limit,
      nextCursor: rows.length > limit ? String(visible.at(-1)!.sequence) : null
    }
  };
}
