import crypto from 'node:crypto';
import { db, event, id, nowIso } from './db.js';
import { decryptJson, encryptJson } from './crypto.js';

export const INTEGRATION_SCOPES = [
  'content:draft:write',
  'content:read',
  'media:write',
  'schedule:write',
  'approval:request',
  'publish:request'
] as const;

export type IntegrationScope = typeof INTEGRATION_SCOPES[number];
export type ApiKeyMetadata = {
  id: string;
  name: string;
  prefix: string;
  scopes: IntegrationScope[];
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  rotatedFromId: string | null;
};

type ApiKeyRow = {
  id: string; name: string; prefix: string; key_hash: string; scopes_json: string;
  revoked_at: string | null; created_at: string; last_used_at: string | null; rotated_from_id: string | null;
};function normalizeScopes(scopes: readonly IntegrationScope[]): IntegrationScope[] {
  const allowed = new Set<IntegrationScope>(INTEGRATION_SCOPES);
  const unique = [...new Set(scopes)];
  if (unique.length === 0) throw new Error('API key requires at least one scope');
  for (const scope of unique) if (!allowed.has(scope)) throw new Error(`Unsupported API key scope: ${scope}`);
  return unique.sort();
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function metadata(row: ApiKeyRow): ApiKeyMetadata {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: JSON.parse(row.scopes_json) as IntegrationScope[],
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    rotatedFromId: row.rotated_from_id
  };
}

function generateApiToken(): string {
  return `pk_${crypto.randomBytes(32).toString('base64url')}`;
}
function insertApiKey(nameRaw: string, scopesRaw: readonly IntegrationScope[], rotatedFromId: string | null): { token: string; key: ApiKeyMetadata } {
  const name = nameRaw.trim();
  if (!name || name.length > 120) throw new Error('API key name must be 1-120 characters');
  const scopes = normalizeScopes(scopesRaw);
  const token = generateApiToken();
  const rowId = id('key');
  const createdAt = nowIso();
  const prefix = token.slice(0, 12);
  db.prepare(`INSERT INTO integration_api_keys
    (id,name,prefix,key_hash,scopes_json,revoked_at,created_at,last_used_at,rotated_from_id)
    VALUES (?,?,?,?,?,NULL,?,NULL,?)`)
    .run(rowId, name, prefix, hashToken(token), JSON.stringify(scopes), createdAt, rotatedFromId);
  const row = db.prepare('SELECT * FROM integration_api_keys WHERE id=?').get(rowId) as ApiKeyRow;
  event({ type: 'api_key.created', message: `Integration API key created: ${name}`, data: { keyId: rowId, prefix, scopes } });
  return { token, key: metadata(row) };
}

export function createIntegrationApiKey(name: string, scopes: readonly IntegrationScope[]): { token: string; key: ApiKeyMetadata } {
  return insertApiKey(name, scopes, null);
}

export function listIntegrationApiKeys(): ApiKeyMetadata[] {
  return (db.prepare('SELECT * FROM integration_api_keys ORDER BY created_at,id').all() as ApiKeyRow[]).map(metadata);
}

export function authenticateIntegrationApiKey(token: string, requiredScope?: IntegrationScope): ApiKeyMetadata {
  if (!/^pk_[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error('Invalid API key');
  const row = db.prepare('SELECT * FROM integration_api_keys WHERE key_hash=?').get(hashToken(token)) as ApiKeyRow | undefined;
  if (!row || row.revoked_at) throw new Error('Invalid or revoked API key');
  const key = metadata(row);
  if (requiredScope && !key.scopes.includes(requiredScope)) throw new Error(`API key lacks scope ${requiredScope}`);
  const usedAt = nowIso();
  db.prepare('UPDATE integration_api_keys SET last_used_at=? WHERE id=?').run(usedAt, row.id);
  return { ...key, lastUsedAt: usedAt };
}

export function revokeIntegrationApiKey(keyId: string): ApiKeyMetadata {
  const row = db.prepare('SELECT * FROM integration_api_keys WHERE id=?').get(keyId) as ApiKeyRow | undefined;
  if (!row) throw new Error('API key not found');
  const revokedAt = row.revoked_at ?? nowIso();
  db.prepare('UPDATE integration_api_keys SET revoked_at=? WHERE id=?').run(revokedAt, keyId);
  event({ type: 'api_key.revoked', message: `Integration API key revoked: ${row.name}`, data: { keyId, prefix: row.prefix } });
  return metadata({ ...row, revoked_at: revokedAt });
}

export function rotateIntegrationApiKey(keyId: string): { token: string; key: ApiKeyMetadata } {
  const row = db.prepare('SELECT * FROM integration_api_keys WHERE id=?').get(keyId) as ApiKeyRow | undefined;
  if (!row || row.revoked_at) throw new Error('Active API key not found');
  const scopes = JSON.parse(row.scopes_json) as IntegrationScope[];
  const transaction = db.transaction(() => {
    db.prepare('UPDATE integration_api_keys SET revoked_at=? WHERE id=?').run(nowIso(), keyId);
    return insertApiKey(row.name, scopes, keyId);
  });
  return transaction();
}

type RateState = { windowStartedAt: number; count: number };
const rateState = new Map<string, RateState>();

export function consumeIntegrationRateLimit(keyId: string, limit = 60, windowMs = 60_000, now = Date.now()): { allowed: boolean; remaining: number; retryAfterMs: number } {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1000) throw new Error('Invalid rate limit configuration');
  const current = rateState.get(keyId);
  const state = !current || now - current.windowStartedAt >= windowMs ? { windowStartedAt: now, count: 0 } : current;
  if (state.count >= limit) {
    rateState.set(keyId, state);
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, state.windowStartedAt + windowMs - now) };
  }
  state.count += 1;
  rateState.set(keyId, state);
  return { allowed: true, remaining: Math.max(0, limit - state.count), retryAfterMs: 0 };
}

export function resetIntegrationRateLimitsForTests(): void {
  rateState.clear();
}

export type ConnectorType = 'google_sheets' | 'google_drive' | 'yandex_disk' | 'generic_https';
export type ConnectorMetadata = {
  id: string; type: ConnectorType; name: string; config: Record<string, unknown>;
  enabled: boolean; createdAt: string; updatedAt: string;
};

type ConnectorRow = {
  id: string; type: ConnectorType; name: string; config_json: string; credentials_encrypted: string;
  enabled: number; created_at: string; updated_at: string;
};

function connectorMetadata(row: ConnectorRow): ConnectorMetadata {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const SECRETISH_CONFIG_KEY = /(secret|token|password|credential|api[_-]?key|access[_-]?key|private[_-]?key)/i;
function boundedJson(value: unknown, label: string): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > 64 * 1024) throw new Error(`${label} exceeds 64 KiB limit`);
  return json;
}
function assertSecretFreeConfig(value: unknown, path = 'config'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertSecretFreeConfig(item, `${path}[${index}]`)); return; }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRETISH_CONFIG_KEY.test(key)) throw new Error(`Connector secret-like field must be stored in credentials: ${path}.${key}`);
    assertSecretFreeConfig(item, `${path}.${key}`);
  }
}

export function createIngestionConnector(params: { type: ConnectorType; name: string; config?: Record<string, unknown>; credentials: Record<string, unknown> }): ConnectorMetadata {
  const name = params.name.trim();
  if (!name || name.length > 120) throw new Error('Connector name must be 1-120 characters');
  const configValue = params.config ?? {};
  assertSecretFreeConfig(configValue);
  const configJson = boundedJson(configValue, 'Connector config');
  const credentialsJson = boundedJson(params.credentials, 'Connector credentials');
  const connectorId = id('conn');
  const now = nowIso();
  db.prepare(`INSERT INTO ingestion_connectors
    (id,type,name,config_json,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?)`)
    .run(connectorId, params.type, name, configJson, encryptJson(JSON.parse(credentialsJson)), now, now);
  const row = db.prepare('SELECT * FROM ingestion_connectors WHERE id=?').get(connectorId) as ConnectorRow;
  event({ type: 'connector.created', message: `Ingestion connector created: ${name}`, data: { connectorId, type: params.type } });
  return connectorMetadata(row);
}

export function readIngestionConnectorCredentials(connectorId: string): Record<string, unknown> {
  const row = db.prepare('SELECT credentials_encrypted FROM ingestion_connectors WHERE id=? AND enabled=1').get(connectorId) as { credentials_encrypted: string } | undefined;
  if (!row) throw new Error('Enabled connector not found');
  return decryptJson<Record<string, unknown>>(row.credentials_encrypted);
}

export function updateIngestionConnectorCredentials(connectorId: string, credentials: Record<string, unknown>): void {
  const credentialsJson = boundedJson(credentials, 'Connector credentials');
  const updated = db.prepare('UPDATE ingestion_connectors SET credentials_encrypted=?,updated_at=? WHERE id=?')
    .run(encryptJson(JSON.parse(credentialsJson)), nowIso(), connectorId);
  if (updated.changes !== 1) throw new Error('Connector not found');
  event({ type: 'connector.credentials_rotated', message: 'Ingestion connector credentials rotated', data: { connectorId } });
}

export function disableIngestionConnector(connectorId: string): void {
  const updated = db.prepare('UPDATE ingestion_connectors SET enabled=0,updated_at=? WHERE id=?').run(nowIso(), connectorId);
  if (updated.changes !== 1) throw new Error('Connector not found');
  event({ type: 'connector.disabled', message: 'Ingestion connector disabled', data: { connectorId } });
}
