import crypto from 'node:crypto';
import { db, id, nowIso } from './db.js';
import { AgentRegistryError } from './agent-registry-error.js';
import {
  getOwnerAgent, ownerReceiptIdentity, replayOwnerResponse,
  persistOwnerResponse, recordOwnerAudit
} from './agent-owner-registry.js';
import { assertEffectiveAgentGrant, type AuthenticatedAgentClaim } from './agent-grant-acl.js';

const MACHINE_CLIENTS = new Set(['n8n','telegram_bot','max_bot','rest_client']);
const MACHINE_TOKEN = /^pak1_[A-Za-z0-9_-]{43}$/;
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_ACTIVE_KEYS = 20;
const MAX_HOURS = 30 * 24;
const FORBIDDEN_SCOPES = new Set(['publish:request','schedule:write']);

type KeyRow = {
  id: string; agent_id: string; prefix: string; scope_ids_json: string;
  token_version: number; grant_version: number;
  expires_at: string; revoked_at: string | null;
  last_used_at: string | null; created_at: string;
};
type OwnerAgentState = {
  id: string; status: string; client_kind: string;
  token_version: number; principal_expiry: string | null;
  grant_version: number; grant_expiry: string | null; scope_ids_json: string;
};
type IssueInput = {
  expectedGrantVersion: number; scopeIds: string[]; ttlHours: number;
};
type RotateInput = { expectedGrantVersion: number; ttlHours: number; confirm: true };
type IssueResponse = {
  machineKey: ReturnType<typeof safeKey>;
  bearerToken: string | null;
  secretAvailable: boolean;
};

function reject(code = 'UNAUTHORIZED', status = 401): never {
  throw new AgentRegistryError(code, code === 'UNAUTHORIZED'
    ? 'Недействительный или отозванный машинный ключ.'
    : 'Операция с машинным ключом запрещена.', status);
}
function inputObject(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AgentRegistryError('VALIDATION_ERROR','Ожидается JSON-объект.');
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(k=>!fields.includes(k))) {
    throw new AgentRegistryError('VALIDATION_ERROR','Лишние поля запроса.');
  }
  return body;
}
function safeVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AgentRegistryError('VALIDATION_ERROR','Укажите актуальную expectedGrantVersion.');
  }
  return Number(value);
}
function safeTtl(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value)>MAX_HOURS) {
    throw new AgentRegistryError('VALIDATION_ERROR','Срок машинного ключа: 1–720 часов.');
  }
  return Number(value);
}
function issueInput(raw: unknown): IssueInput {
  const b=inputObject(raw,['expectedGrantVersion','scopeIds','ttlHours']);
  const version=safeVersion(b.expectedGrantVersion), ttlHours=safeTtl(b.ttlHours);
  if (!Array.isArray(b.scopeIds) || b.scopeIds.length<1 || b.scopeIds.length>13
    || b.scopeIds.some(s=>typeof s!=='string'||!/^[a-z]+:[a-z]+$/.test(s))
    || new Set(b.scopeIds).size!==b.scopeIds.length) {
    throw new AgentRegistryError('VALIDATION_ERROR','Требуется уникальный непустой список scopes.');
  }
  return { expectedGrantVersion:version, scopeIds:[...b.scopeIds].sort(), ttlHours };
}
function rotateInput(raw: unknown): RotateInput {
  const b=inputObject(raw,['expectedGrantVersion','ttlHours','confirm']);
  if (b.confirm!==true) throw new AgentRegistryError('VALIDATION_ERROR','Требуется confirm=true.');
  return { expectedGrantVersion:safeVersion(b.expectedGrantVersion),
    ttlHours:safeTtl(b.ttlHours), confirm:true };
}
function controlInput(raw: unknown): { confirm: true } {
  const b=inputObject(raw,['confirm']);
  if (b.confirm!==true) throw new AgentRegistryError('VALIDATION_ERROR','Требуется confirm=true.');
  return { confirm:true };
}
function validateId(value: string): void {
  if (!VALID_ID.test(value)) {
    throw new AgentRegistryError('VALIDATION_ERROR','Недопустимый идентификатор.',400);
  }
}
function grantState(agentId: string): OwnerAgentState {
  validateId(agentId);
  const row=db.prepare([
    'SELECT p.id,p.status,p.client_kind,p.token_version,',
    'p.expires_at AS principal_expiry,',
    'g.grant_version,g.expires_at AS grant_expiry,g.scope_ids_json',
    'FROM agent_principals p JOIN agent_grants g ON g.agent_id=p.id',
    'WHERE p.id=?'
  ].join(' ')).get(agentId) as OwnerAgentState | undefined;
  if (!row) throw new AgentRegistryError('RESOURCE_NOT_FOUND','Бот не найден.',404);
  return row;
}
function activeExpiry(value: string | null): boolean {
  return value === null || (Number.isFinite(Date.parse(value)) && Date.parse(value)>Date.now());
}
function requireActiveMachineAgent(agentId: string, version: number): OwnerAgentState {
  const row=grantState(agentId);
  if (row.grant_version!==version) throw new AgentRegistryError(
    'STALE_GRANT_VERSION','Версия разрешений изменилась.',409);
  if (!MACHINE_CLIENTS.has(row.client_kind) || row.status!=='ACTIVE'
    || !activeExpiry(row.principal_expiry)||!activeExpiry(row.grant_expiry)) reject('POLICY_DENIED',403);
  return row;
}
function validateKeyScopes(scopes: readonly string[], grant: OwnerAgentState): void {
  const current = new Set(JSON.parse(grant.scope_ids_json) as string[]);
  if (scopes.some(s=>!current.has(s)||FORBIDDEN_SCOPES.has(s))) reject('POLICY_DENIED',403);
}
function safeKey(key: KeyRow) {
  return {
    keyId:key.id,agentId:key.agent_id,prefix:key.prefix,
    scopeIds:JSON.parse(key.scope_ids_json) as string[],
    tokenVersion:key.token_version,grantVersion:key.grant_version,
    expiresAt:key.expires_at,revokedAt:key.revoked_at,
    createdAt:key.created_at,lastUsedAt:key.last_used_at
  };
}
function getKey(agentId: string, keyId: string): KeyRow {
  validateId(agentId);validateId(keyId);
  const row=db.prepare('SELECT * FROM agent_machine_keys WHERE agent_id=? AND id=?')
    .get(agentId,keyId) as KeyRow | undefined;
  if (!row) throw new AgentRegistryError('RESOURCE_NOT_FOUND','Машинный ключ не найден.',404);
  return row;
}
function maxDate(hours: number, owner: OwnerAgentState): string {
  const expires=[Date.now()+hours*3_600_000];
  if (owner.principal_expiry!==null)expires.push(Date.parse(owner.principal_expiry));
  if (owner.grant_expiry!==null)expires.push(Date.parse(owner.grant_expiry));
  const earliest=Math.min(...expires);
  if (!Number.isFinite(earliest)||earliest<=Date.now()) reject('POLICY_DENIED',403);
  return new Date(earliest).toISOString();
}
function insertMachineKey(agentId: string, grant: OwnerAgentState,
  scopes: string[], ttlHours: number): { row: KeyRow; token: string } {
  validateKeyScopes(scopes,grant);
  const active=db.prepare([
    'SELECT COUNT(*) AS n FROM agent_machine_keys',
    'WHERE agent_id=? AND revoked_at IS NULL AND expires_at>?'
  ].join(' ')).get(agentId,nowIso()) as {n:number};
  if (active.n>=MAX_ACTIVE_KEYS) throw new AgentRegistryError(
    'MACHINE_KEY_LIMIT','Достигнут лимит действующих ключей.',429);
  const token='pak1_'+crypto.randomBytes(32).toString('base64url');
  const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
  const keyId=id('amk');
  const at=nowIso(), expiresAt=maxDate(ttlHours,grant);
  db.prepare([
    'INSERT INTO agent_machine_keys',
    '(id,agent_id,token_hash,prefix,scope_ids_json,token_version,grant_version,',
    'expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ].join(' ')).run(keyId,agentId,tokenHash,token.slice(0,14),
    JSON.stringify(scopes),grant.token_version,grant.grant_version,expiresAt,at);
  return {row:getKey(agentId,keyId),token};
}
/** Only owner read; never return token_hash. */
export function listOwnerMachineKeys(agentId: string): { items: ReturnType<typeof safeKey>[] } {
  getOwnerAgent(agentId);
  // All live credentials must remain visible despite unbounded historic
  // revoked/expired records. Issuance caps active keys at 20 (< page size).
  const rows=db.prepare([
    'SELECT * FROM agent_machine_keys WHERE agent_id=?',
    'ORDER BY CASE WHEN revoked_at IS NULL AND expires_at>? THEN 0 ELSE 1 END,',
    'created_at DESC,id DESC LIMIT 100'
  ].join(' ')).all(agentId,nowIso()) as KeyRow[];
  return {items:rows.map(safeKey)};
}
/**
 * One-time secret display. A replay has no bearerToken; an owner who lost the
 * initial response must revoke and mint a new key. No recoverable secret is
 * stored in a backup, response receipt or server-side event.
 */
export function issueOwnerMachineKey(agentId: string, raw: unknown, idem: string): IssueResponse {
  const input=issueInput(raw);
  const op='issueOwnerMachineKey';
  const {requestId,fingerprint}=ownerReceiptIdentity(op,idem,{agentId,...input});
  return db.transaction(()=>{
    const replay=replayOwnerResponse<{machineKey:ReturnType<typeof safeKey>}>(
      op,requestId,fingerprint);
    if (replay) return {...replay,bearerToken:null,secretAvailable:false};
    const owner=requireActiveMachineAgent(agentId,input.expectedGrantVersion);
    validateKeyScopes(input.scopeIds,owner);
    const issued=insertMachineKey(agentId,owner,input.scopeIds,input.ttlHours);
    const safe={machineKey:safeKey(issued.row)};
    recordOwnerAudit(agentId,requestId,fingerprint,op,'COMPLETED',
      'Владелец выпустил машинный ключ с ограниченными правами.',owner.grant_version);
    persistOwnerResponse(agentId,op,requestId,fingerprint,safe);
    return {...safe,bearerToken:issued.token,secretAvailable:true};
  }).immediate();
}
export function revokeOwnerMachineKey(agentId: string,keyId: string, raw: unknown,
  idem: string): ReturnType<typeof safeKey> {
  const input=controlInput(raw),op='revokeOwnerMachineKey';
  validateId(agentId);validateId(keyId);
  const {requestId,fingerprint}=ownerReceiptIdentity(op,idem,{agentId,keyId,...input});
  return db.transaction(()=>{
    const replay=replayOwnerResponse<ReturnType<typeof safeKey>>(op,requestId,fingerprint);
    if (replay) return replay;
    const key=getKey(agentId,keyId);
    if (key.revoked_at!==null) reject('POLICY_DENIED',409);
    db.prepare('UPDATE agent_machine_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
      .run(nowIso(),keyId);
    const response=safeKey(getKey(agentId,keyId));
    recordOwnerAudit(agentId,requestId,fingerprint,op,'REVOKED',
      'Владелец отозвал машинный ключ.',key.grant_version);
    persistOwnerResponse(agentId,op,requestId,fingerprint,response);
    return response;
  }).immediate();
}
export function rotateOwnerMachineKey(agentId: string,keyId: string,raw:unknown,
  idem:string):IssueResponse {
  const input=rotateInput(raw),op='rotateOwnerMachineKey';
  validateId(agentId);validateId(keyId);
  const {requestId,fingerprint}=ownerReceiptIdentity(op,idem,{agentId,keyId,...input});
  return db.transaction(()=>{
    const replay=replayOwnerResponse<{machineKey:ReturnType<typeof safeKey>}>(
      op,requestId,fingerprint);
    if (replay) return {...replay,bearerToken:null,secretAvailable:false};
    const owner=requireActiveMachineAgent(agentId,input.expectedGrantVersion);
    const old=getKey(agentId,keyId);
    if (old.revoked_at!==null || Date.parse(old.expires_at)<=Date.now()
      || old.token_version!==owner.token_version
      || old.grant_version!==owner.grant_version) reject('POLICY_DENIED',409);
    const scopes=JSON.parse(old.scope_ids_json) as string[];
    validateKeyScopes(scopes,owner);
    // New key and old-key revocation are committed together; never overlap.
    db.prepare('UPDATE agent_machine_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
      .run(nowIso(),keyId);
    const issued=insertMachineKey(agentId,owner,scopes,input.ttlHours);
    const safe={machineKey:safeKey(issued.row)};
    recordOwnerAudit(agentId,requestId,fingerprint,op,'COMPLETED',
      'Владелец перевыпустил ключ; прежний отозван.',owner.grant_version);
    persistOwnerResponse(agentId,op,requestId,fingerprint,safe);
    return {...safe,bearerToken:issued.token,secretAvailable:true};
  }).immediate();
}
export type VerifiedMachineKey = {
  keyId:string;agentId:string;tokenVersion:number;grantVersion:number;
  tokenScopes:string[];
};
/** Internal service authentication: not an HTTP or MCP credential endpoint. */
export function authenticateAgentMachineKey(token: unknown): VerifiedMachineKey {
  if (typeof token!=='string'||!MACHINE_TOKEN.test(token))return reject();
  const hash=crypto.createHash('sha256').update(token).digest('hex');
  const row=db.prepare('SELECT * FROM agent_machine_keys WHERE token_hash=?')
    .get(hash) as KeyRow|undefined;
  if (!row||row.revoked_at!==null||!activeExpiry(row.expires_at))return reject();
  const owner=grantState(row.agent_id);
  if (!MACHINE_CLIENTS.has(owner.client_kind)||owner.status!=='ACTIVE'
    ||!activeExpiry(owner.principal_expiry)||!activeExpiry(owner.grant_expiry)
    ||row.token_version!==owner.token_version||row.grant_version!==owner.grant_version) return reject();
  const tokenScopes=JSON.parse(row.scope_ids_json) as string[];
  const granted=new Set(JSON.parse(owner.scope_ids_json) as string[]);
  if (!tokenScopes.length||tokenScopes.some(s=>!granted.has(s)||FORBIDDEN_SCOPES.has(s)))return reject();
  return {keyId:row.id,agentId:row.agent_id,tokenVersion:row.token_version,
    grantVersion:row.grant_version,tokenScopes};
}
/** Future REST/MCP routes MUST use this fresh operation-time check. */
export function authorizeAgentMachineOperation(token:unknown,
  claim:Omit<AuthenticatedAgentClaim,'agentId'|'tokenVersion'|'grantVersion'|'tokenScopes'>) {
  return db.transaction(()=>{
    const principal=authenticateAgentMachineKey(token);
    return assertEffectiveAgentGrant({...principal,...claim});
  }).immediate();
}
