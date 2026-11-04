import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db, id, nowIso } from './db.js';
import { sessionAdmin } from './admin-auth.js';
import { encryptJson, decryptJson } from './crypto.js';
import { config } from './config.js';

export class OwnerAutomationError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export type OwnerActor = { kind: 'session' | 'key'; ownerId: string; actorId: string; session?: string };
type Delegation = { actor: OwnerActor; method: string; url: string; nonce: string };
const delegation = new AsyncLocalStorage<Delegation>();
// light-my-request may create an AsyncResource outside the caller context.
// A server-created, single-request capability bridges that boundary; no external
// request can mint one, and it is removed immediately after the injection ends.
const pendingDelegations = new Map<string, Delegation>();
const claimedDelegations = new WeakMap<FastifyRequest, Delegation>();
const claimedNonces = new Set<string>();
const activeReceipts = new Set<string>();
export const digest = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
export function objectValue(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OwnerAutomationError('INVALID_INPUT', 'Ожидается JSON-объект.');
  return value as Record<string, any>;
}
export function boundedString(value: unknown, name: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new OwnerAutomationError('INVALID_INPUT', `Некорректное поле ${name}.`);
  }
  return value.trim();
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

/** Never return provider credentials, ciphertext, session cookies or private keys to a model. */
export function safeOutput(value: unknown, depth = 0): any {
  if (depth > 16) return '[depth limit]';
  if (typeof value === 'string') return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{15,}|vk1\.[A-Za-z0-9._-]{20,}|(?:pom1|pak1|pk|pa2)_[A-Za-z0-9_-]{15,}|\d{6,15}:[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]')
    .replace(/([?&](?:access_token|token|key|secret|signature)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 24000);
  if (Array.isArray(value)) return value.slice(0, 200).map(v => safeOutput(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, val] of Object.entries(value)) {
      if (/^(?:__proto__|constructor|prototype)$/.test(key)) continue;
      if (/(?:password|secret|private.?key|credentials_encrypted|message_encrypted|result_encrypted|key_hash|authorization|cookie|refresh.?token|access.?token|api.?key|master.?key|client.?secret|raw.?response|stack)$/i.test(key)
          || key === 'credentials' || key === 'token') { out[key] = '[REDACTED]'; continue; }
      out[key] = safeOutput(val, depth + 1);
    }
    return out;
  }
  return value;
}

export function sessionActor(request: FastifyRequest): OwnerActor {
  if (request.headers.authorization !== undefined) throw new OwnerAutomationError('UNAUTHORIZED', 'Требуется вход владельца.', 401);
  const session = request.cookies?.publikator_session;
  const owner = sessionAdmin(session);
  if (!owner) throw new OwnerAutomationError('UNAUTHORIZED', 'Требуется вход владельца.', 401);
  return { kind: 'session', ownerId: 'owner', actorId: 'owner:owner', session };
}
export function assertOwnerActor(actor: OwnerActor): void {
  if (actor.kind === 'session') {
    const owner = sessionAdmin(actor.session);
    if (!owner || actor.ownerId !== 'owner') throw new OwnerAutomationError('UNAUTHORIZED', 'Сессия владельца завершена.', 401);
  } else {
    const key = db.prepare(`SELECT k.id FROM owner_automation_keys k JOIN admin_users a ON a.id=k.owner_id
      WHERE k.id=? AND k.owner_id=? AND k.role='OWNER_ADMIN' AND k.revoked_at IS NULL AND k.expires_at>?`)
      .get(actor.actorId, actor.ownerId, nowIso());
    if (!key) throw new OwnerAutomationError('UNAUTHORIZED', 'Ключ отключён или истёк.', 401);
  }
}
export function authenticateOwnerKey(header: unknown): OwnerActor {
  if (typeof header !== 'string' || !/^Bearer pom1_[A-Za-z0-9_-]{43}$/.test(header)) {
    throw new OwnerAutomationError('UNAUTHORIZED', 'Требуется отдельный ключ администратора MCP.', 401);
  }
  const hash = digest(header.slice(7));
  const row = db.prepare(`SELECT id,owner_id FROM owner_automation_keys
    WHERE key_hash=? AND role='OWNER_ADMIN' AND revoked_at IS NULL AND expires_at>?`).get(hash, nowIso()) as any;
  if (!row) throw new OwnerAutomationError('UNAUTHORIZED', 'Ключ отключён или истёк.', 401);
  const actor: OwnerActor = { kind: 'key', ownerId: row.owner_id, actorId: row.id };
  assertOwnerActor(actor);
  return actor;
}
export function createOwnerAutomationKey(ownerId: string, input: unknown): any {
  const b = objectValue(input);
  if (b.confirmOwnerAdmin !== true) throw new OwnerAutomationError('ADMIN_CONFIRMATION_REQUIRED', 'Подтвердите выдачу административного доступа.');
  const name = boundedString(b.name, 'name', 120);
  const days = b.days === undefined ? 90 : Number(b.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new OwnerAutomationError('INVALID_INPUT', 'Срок ключа: от 1 до 366 дней.');
  const token = 'pom1_' + crypto.randomBytes(32).toString('base64url');
  const keyId = id('omk');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare(`INSERT INTO owner_automation_keys(id,owner_id,name,prefix,key_hash,role,created_at,expires_at)
    VALUES(?,?,?,?,?,'OWNER_ADMIN',?,?)`).run(keyId, ownerId, name, token.slice(0, 12), digest(token), createdAt, expiresAt);
  return { id: keyId, name, role: 'OWNER_ADMIN', createdAt, expiresAt, token };
}
export function listOwnerAutomationKeys(ownerId: string): any[] {
  return db.prepare(`SELECT id,name,prefix,role,created_at,expires_at,revoked_at,last_used_at
    FROM owner_automation_keys WHERE owner_id=? ORDER BY created_at DESC`).all(ownerId);
}
export function revokeOwnerAutomationKey(ownerId: string, keyId: string): void {
  const r = db.prepare('UPDATE owner_automation_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND owner_id=?').run(nowIso(), keyId, ownerId);
  if (!r.changes) throw new OwnerAutomationError('NOT_FOUND', 'Ключ не найден.', 404);
}

/** A header alone never grants access: it must match a live, single-request server permit. */
export function isOwnerAutomationRequest(request: FastifyRequest): boolean {
  const nonce = request.headers['x-publikator-owner-delegation'];
  if (typeof nonce !== 'string') return false;
  const known = claimedDelegations.get(request);
  const ctx = known || delegation.getStore() || pendingDelegations.get(nonce);
  if (!ctx || !pendingDelegations.has(nonce) || request.method !== ctx.method || request.url !== ctx.url || nonce !== ctx.nonce) return false;
  if (!known) {
    if (claimedNonces.has(nonce)) return false;
    claimedNonces.add(nonce);
    claimedDelegations.set(request, ctx);
  }
  assertOwnerActor(ctx.actor);
  return true;
}
export function ownerAutomationActorSource(request: FastifyRequest): 'owner_assistant' | 'manual' {
  return isOwnerAutomationRequest(request) ? 'owner_assistant' : 'manual';
}
export async function callCanonicalApi(app: FastifyInstance, actor: OwnerActor, method: string, url: string,
  payload?: any, extraHeaders: Record<string, string> = {}): Promise<{ status: number; data: any }> {
  assertOwnerActor(actor);
  if (!url.startsWith('/api/') || url.includes('://') || url.includes('\\') || /[\r\n\u0000]/.test(url)) {
    throw new OwnerAutomationError('INVALID_ROUTE', 'Разрешены только зарегистрированные операции Publikator.');
  }
  const nonce = crypto.randomBytes(24).toString('hex');
  const origin = new URL(config.publicBaseUrl || 'http://127.0.0.1:8080').origin;
  const context = { actor, method, url, nonce };
  pendingDelegations.set(nonce, context);
  let response;
  try {
    response = await delegation.run(context, () => app.inject({
      method: method as any, url, payload,
      headers: { ...extraHeaders, host: new URL(origin).host, origin, 'x-publikator-owner-delegation': nonce }
    }));
  } finally { pendingDelegations.delete(nonce); claimedNonces.delete(nonce); }
  if (!(response.headers['content-type'] || '').toString().includes('application/json')) {
    throw new OwnerAutomationError('NON_JSON_OPERATION', 'Эта операция возвращает файл; используйте предназначенный для файлов инструмент.', 409);
  }
  return { status: response.statusCode, data: safeOutput(response.json()) };
}
export function recordOwnerEvent(actor: OwnerActor, operation: string, status: string, receiptId: string | null = null): void {
  db.prepare(`INSERT INTO owner_automation_events(id,owner_id,actor_id,operation,status,receipt_id,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(id('ome'), actor.ownerId, actor.actorId, operation, status, receiptId, nowIso());
}
export async function withOwnerReceipt(actor: OwnerActor, operation: string, input: unknown, requestKey: unknown,
  action: () => Promise<any>): Promise<any> {
  assertOwnerActor(actor);
  const key = boundedString(requestKey, 'idempotencyKey', 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new OwnerAutomationError('INVALID_INPUT', 'Некорректный idempotencyKey.');
  const requestHash = digest(canonicalJson(input));
  const receipt = db.transaction(() => {
    const old = db.prepare(`SELECT * FROM owner_automation_receipts WHERE actor_id=? AND operation=? AND request_key_hash=?`)
      .get(actor.actorId, operation, digest(key)) as any;
    if (old) {
      if (old.request_hash !== requestHash) throw new OwnerAutomationError('IDEMPOTENCY_CONFLICT', 'Этот ключ уже использован с другими параметрами.', 409);
      if (old.status === 'COMPLETED') return { id: old.id as string, result: decryptJson<any>(old.result_encrypted), replay: true };
      throw new OwnerAutomationError(activeReceipts.has(old.id) ? 'IN_PROGRESS' : 'RECOVERY_NEEDED',
        activeReceipts.has(old.id) ? 'Операция ещё выполняется.' : 'Исход предыдущего выполнения не подтверждён. Проверьте состояние объекта; автоматический повтор запрещён.', 409);
    }
    const receiptId = id('omr');
    db.prepare(`INSERT INTO owner_automation_receipts(id,owner_id,actor_id,operation,request_key_hash,request_hash,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'STARTED',?,?)`).run(receiptId, actor.ownerId, actor.actorId, operation, digest(key), requestHash, nowIso(), nowIso());
    return { id: receiptId, replay: false, result: undefined };
  }).immediate();
  if (receipt.replay) return { ...receipt.result, replayed: true };
  activeReceipts.add(receipt.id);
  recordOwnerEvent(actor, operation, 'STARTED', receipt.id);
  try {
    assertOwnerActor(actor);
    const result = safeOutput(await action());
    db.prepare(`UPDATE owner_automation_receipts SET status='COMPLETED',result_encrypted=?,updated_at=? WHERE id=?`)
      .run(encryptJson(result), nowIso(), receipt.id);
    recordOwnerEvent(actor, operation, result?.status >= 400 || result?.isError ? 'FAILED' : 'COMPLETED', receipt.id);
    return result;
  } catch (error) {
    db.prepare(`UPDATE owner_automation_receipts SET status='RECOVERY_NEEDED',updated_at=? WHERE id=?`).run(nowIso(), receipt.id);
    recordOwnerEvent(actor, operation, 'RECOVERY_NEEDED', receipt.id);
    throw error;
  } finally { activeReceipts.delete(receipt.id); }
}
