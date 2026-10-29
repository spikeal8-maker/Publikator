import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, id, nowIso } from '../db.js';
import { AgentRegistryError } from '../agent-registry-error.js';
import { assertEffectiveAgentGrant } from '../agent-grant-acl.js';
import { resolveEditorialUpdateV3, EditorialDraftContractError } from '../content-plan-v3.js';
import {
  commitContentEdit, ContentConflictError, ContentImmutableError, type ContentRevisionRow
} from '../content-versioning.js';
import {
  verifiedAgentBearer, respondAgentBearerFailure, AgentBearerFailure
} from './agent-bearer-boundary.js';

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERATION = 'updateAgentPost';
const MAX_UPDATES_PER_HOUR = 120;

type Patch = {
  expectedContentVersion: number;
  internalTitle?: string;
  bodyPlain?: string;
};
type Receipt = {
  canonical_payload_hash: string;
  phase: string;
  post_id: string | null;
  result_json: string | null;
};
type StoredPost = {
  id: string; project_id: string; title: string; body: string;
  content_version: number; source_type: string; status: string;
  editorial_stage: string; content_format: string; publication_kind: string;
  schedule_mode: string; scheduled_at: string | null;
  scheduled_at_utc: string | null; ready_revision_id: string | null;
};
type ReceiptResult = {
  // SQLite 18 only permits this minimal safe receipt DTO.
  // Project and revision ID are derived from the immutable post/revision
  // during replay; never add arbitrary fields to durable result_json.
  postId: string; contentVersion: number; status: 'DRAFT';
};
type Target = { account_id: string; enabled: number; active: number;
  override_text: string | null; rendition_id: string | null };

function deny(code: string, status: number, message: string): never {
  throw new AgentRegistryError(code, message, status);
}
function hash(value: string) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function normalizeBody(raw: unknown): Patch {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    deny('VALIDATION_ERROR', 400, 'Требуется JSON-объект изменения.');
  }
  const data = raw as Record<string, unknown>;
  const allowed = new Set(['expectedContentVersion','internalTitle','bodyPlain']);
  if (Object.keys(data).some(k => !allowed.has(k))) {
    deny('FEATURE_NOT_ENABLED', 403, 'Изменение целей, медиа или статуса здесь недоступно.');
  }
  if (!Number.isSafeInteger(data.expectedContentVersion)
    || Number(data.expectedContentVersion) < 1) {
    deny('VALIDATION_ERROR', 400, 'Требуется expectedContentVersion >= 1.');
  }
  if (data.internalTitle === undefined && data.bodyPlain === undefined) {
    deny('VALIDATION_ERROR', 400, 'Укажите новый текст или название.');
  }
  const out: Patch = { expectedContentVersion: Number(data.expectedContentVersion) };
  if (data.internalTitle !== undefined) {
    if (typeof data.internalTitle !== 'string'
      || !data.internalTitle.trim()
      || data.internalTitle.trim().length > 160
      || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(data.internalTitle)) {
      deny('VALIDATION_ERROR', 400, 'Название: от 1 до 160 символов.');
    }
    out.internalTitle = data.internalTitle.trim();
  }
  if (data.bodyPlain !== undefined) {
    if (typeof data.bodyPlain !== 'string'
      || !data.bodyPlain.trim() || data.bodyPlain.length > 20000
      || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(data.bodyPlain)) {
      deny('VALIDATION_ERROR', 400, 'Текст: от 1 до 20000 символов.');
    }
    out.bodyPlain = data.bodyPlain.trim();
  }
  return out;
}
function readRevision(postId: string, version: number): ContentRevisionRow {
  // UNIQUE(post_id,content_version) identifies the original immutable
  // revision without persisting a revisionId in the schema-18 receipt.
  const row = db.prepare([
    'SELECT * FROM content_revisions',
    'WHERE post_id=? AND content_version=?'
  ].join(' ')).get(postId, version) as ContentRevisionRow | undefined;
  if (!row || row.actor_source !== 'agent_api' || row.editorial_stage !== 'DRAFT'
    || row.schedule_mode !== 'MANUAL'
    || row.scheduled_at !== null || row.scheduled_at_utc !== null
    || row.content_format !== 'TEXT_ONLY' || row.publication_kind !== 'FEED') {
    deny('RECOVERY_NEEDED', 409, 'Не удалось подтвердить сохранённую версию черновика.');
  }
  return row;
}
function getTargets(postId: string): Target[] {
  return db.prepare([
    'SELECT pt.account_id,pt.enabled,sa.enabled AS active,pt.override_text,',
    'tr.target_id AS rendition_id',
    'FROM post_targets pt LEFT JOIN social_accounts sa ON sa.id=pt.account_id',
    'LEFT JOIN target_renditions tr ON tr.target_id=pt.id',
    'WHERE pt.post_id=? ORDER BY pt.account_id'
  ].join(' ')).all(postId) as Target[];
}

function revisionResponse(
  revision: ContentRevisionRow, stored: ReceiptResult, targets: Target[], projectId: string
) {
  return {
    postId: stored.postId,
    projectId,
    contentVersion: stored.contentVersion,
    status: 'DRAFT' as const,
    editorialStage: 'DRAFT' as const,
    internalTitle: revision.title,
    bodyPlain: revision.body,
    contentFormat: 'TEXT_ONLY' as const,
    publicationKind: 'FEED' as const,
    targetAccountIds: targets.map(t => t.account_id),
    mediaAssetIds: [] as string[],
    targetTextOverrides: [] as unknown[],
    schedule: null
  };
}

/** A2b2: PATCH only a still-active, agent-owned, text-only DRAFT. */
function applyPatch(req: FastifyRequest, postId: string, raw: unknown, idem: string) {
  if (!IDENTIFIER.test(postId)) {
    deny('VALIDATION_ERROR', 400, 'Некорректный postId.');
  }
  const patch = normalizeBody(raw);
  const fingerprint = hash(JSON.stringify({ postId, ...patch }));
  return db.transaction(() => {
    // Do not trust the agentId, target IDs, grantVersion or content status
    // from any user/model-supplied fields: only the authenticated DB identity.
    const principal = verifiedAgentBearer(req);
    const post = db.prepare([
      'SELECT p.* FROM posts p JOIN agent_draft_ownership o ON o.post_id=p.id',
      'WHERE p.id=? AND o.agent_id=?'
    ].join(' ')).get(postId, principal.agentId) as StoredPost | undefined;
    if (!post) deny('RESOURCE_NOT_FOUND', 404, 'Черновик недоступен.');
    if (post.source_type !== 'agent-api' || post.status !== 'DRAFT'
      || post.editorial_stage !== 'DRAFT' || post.schedule_mode !== 'MANUAL'
      || post.scheduled_at !== null || post.scheduled_at_utc !== null
      || post.content_format !== 'TEXT_ONLY' || post.publication_kind !== 'FEED'
      || post.ready_revision_id !== null) {
      deny('POLICY_DENIED', 409, 'Этот черновик нельзя изменять через Agent API.');
    }
    const targets = getTargets(postId);
    if (!targets.length || targets.length > 20
      || targets.some(t => t.enabled !== 1 || t.active !== 1
        || t.override_text !== null || t.rendition_id !== null)
      || db.prepare('SELECT 1 FROM media WHERE post_id=?').get(postId)
      || db.prepare('SELECT 1 FROM content_media WHERE post_id=?').get(postId)) {
      deny('POLICY_DENIED', 409, 'Черновик содержит неподдерживаемые ресурсы.');
    }
    for (const target of targets) {
      assertEffectiveAgentGrant({
        agentId: principal.agentId, tokenVersion: principal.tokenVersion,
        grantVersion: principal.grantVersion, tokenScopes: principal.tokenScopes,
        requiredScope: 'posts:write', postId, projectId: post.project_id,
        accountId: target.account_id
      });
    }
    const keyHash = hash('AGENT\0' + principal.agentId + '\0' + OPERATION + '\0' + idem);
    const previous = db.prepare([
      'SELECT canonical_payload_hash,phase,post_id,result_json',
      'FROM agent_operation_receipts',
      'WHERE agent_id=? AND operation_name=? AND idempotency_key_hash=?'
    ].join(' ')).get(principal.agentId, OPERATION, keyHash) as Receipt | undefined;
    if (previous) {
      if (previous.canonical_payload_hash !== fingerprint
        || previous.post_id !== postId) {
        deny('IDEMPOTENCY_CONFLICT', 409, 'Ключ уже использован для другого изменения.');
      }
      if (previous.phase !== 'COMPLETED' || !previous.result_json) {
        deny('RECOVERY_NEEDED', 409, 'Исходное изменение требует проверки.');
      }
      let original: ReceiptResult;
      try { original = JSON.parse(previous.result_json) as ReceiptResult; }
      catch { deny('RECOVERY_NEEDED', 409, 'Повреждена квитанция предыдущего изменения.'); }
      if (original.postId !== postId
        || !Number.isSafeInteger(original.contentVersion)
        || original.contentVersion !== patch.expectedContentVersion + 1
        || original.status !== 'DRAFT') {
        deny('RECOVERY_NEEDED', 409, 'Не удалось подтвердить квитанцию.');
      }
      const revision = readRevision(postId, original.contentVersion);
      const originalTargets = JSON.parse(revision.targets_json) as Array<{ accountId?: string }>;
      const currentIds = targets.map(t => t.account_id);
      const historicIds = originalTargets.map(t => t.accountId).sort();
      if (historicIds.length !== currentIds.length
        || historicIds.some((x, i) => x !== currentIds[i])) {
        deny('RECOVERY_NEEDED', 409, 'Набор получателей черновика изменён.');
      }
      return { replay: true, data: revisionResponse(revision, original, targets, post.project_id) };
    }
    if (post.content_version !== patch.expectedContentVersion) {
      deny('CONTENT_VERSION_CONFLICT', 409, 'Версия содержимого изменилась.');
    }
    const since = new Date(Date.now() - 3600000).toISOString();
    const budget = db.prepare([
      "SELECT COUNT(*) AS n FROM agent_operation_receipts",
      "WHERE agent_id=? AND operation_name=? AND phase='COMPLETED'",
      "AND created_at>=?"
    ].join(' ')).get(principal.agentId, OPERATION, since) as { n: number };
    if (budget.n >= 120) {
      deny('RATE_LIMITED', 429, 'Лимит 120 изменений черновиков в час.');
    }
    const resolved = resolveEditorialUpdateV3(postId, {
      ...(patch.internalTitle !== undefined ? { internalTitle: patch.internalTitle } : {}),
      ...(patch.bodyPlain !== undefined ? { body: patch.bodyPlain } : {})
    });
    if (resolved.scheduleMode !== 'MANUAL' || resolved.scheduledAt !== null
      || resolved.contentFormat !== 'TEXT_ONLY' || resolved.publicationKind !== 'FEED'
      || resolved.targets.length !== targets.length || resolved.overrides.length !== 0
      || resolved.targets.some(t => !targets.some(x => x.account_id === t.accountId))) {
      deny('POLICY_DENIED', 409, 'Канонический редактор изменил запрещённые поля.');
    }
    if (resolved.title === post.title && resolved.body === post.body
      && patch.bodyPlain === undefined) {
      deny('VALIDATION_ERROR', 400, 'Изменение не содержит новых данных.');
    }
    const saved = commitContentEdit(postId, patch.expectedContentVersion, 'agent_api', () => {
      db.prepare([
        'UPDATE posts SET title=?,body=?,body_rich_json=?',
        'WHERE id=? AND content_version=? AND source_type=?'
      ].join(' ')).run(resolved.title, resolved.body, resolved.bodyRichJson,
        postId, patch.expectedContentVersion, 'agent-api');
    }, { status: 'DRAFT', editorialStage: 'DRAFT' });
    const revision = readRevision(postId, saved.contentVersion);
    if (revision.id !== saved.revision.id) {
      deny('RECOVERY_NEEDED', 409, 'Не удалось подтвердить новую ревизию.');
    }
    const result: ReceiptResult = {
      postId, contentVersion: saved.contentVersion, status: 'DRAFT'
    };
    db.prepare([
      'INSERT INTO agent_operation_receipts',
      '(receipt_id,agent_id,operation_name,idempotency_key_hash,',
      'canonical_payload_hash,post_id,phase,result_json,created_at,updated_at)',
      'VALUES (?,?,?,?,?,?,?,?,?,?)'
    ].join(' ')).run(id('arec'), principal.agentId, OPERATION, keyHash,
      fingerprint, postId, 'COMPLETED', JSON.stringify(result), nowIso(), nowIso());
    db.prepare([
      'INSERT INTO agent_activity_events',
      '(event_id,agent_id,actor_type,origin,request_id,operation_id,',
      'post_id,grant_version,stage,outcome,safe_summary,occurred_at)',
      "VALUES (?,?,'AGENT','REST',?,?,?,?,'COMPLETED','SUCCEEDED',?,?)"
    ].join(' ')).run(id('evt'), principal.agentId, 'req_' + keyHash,
      OPERATION, postId, principal.grantVersion,
      'Агент изменил только текст собственного черновика.', nowIso());
    return { replay: false, data: revisionResponse(revision, result, targets, post.project_id) };
  }).immediate();
}
function safeError(reply: FastifyReply, e: unknown) {
  if (e instanceof AgentRegistryError) {
    const allowed = new Set([
      'VALIDATION_ERROR','FEATURE_NOT_ENABLED','RESOURCE_NOT_FOUND',
      'RESOURCE_DENIED','POLICY_DENIED','IDEMPOTENCY_CONFLICT',
      'RECOVERY_NEEDED','CONTENT_VERSION_CONFLICT','RATE_LIMITED'
    ]);
    if (allowed.has(e.code)) {
      if (e.code === 'RATE_LIMITED') reply.header('retry-after','3600');
      return reply.code(e.status).send({
        error: { code:e.code,message:e.message },
        requestId:id('req'),retryable:e.code==='RATE_LIMITED'
      });
    }
  }
  if (e instanceof ContentConflictError || e instanceof ContentImmutableError) {
    return reply.code(409).send({
      error: { code:'CONTENT_VERSION_CONFLICT',message:'Нельзя сохранить изменение версии.' },
      requestId:id('req'),retryable:false
    });
  }
  if (e instanceof EditorialDraftContractError) {
    return reply.code(400).send({
      error: { code:'VALIDATION_ERROR',message:'Некорректное содержимое черновика.' },
      requestId:id('req'),retryable:false
    });
  }
  if (e instanceof AgentBearerFailure) return respondAgentBearerFailure(reply,e);
  return reply.code(500).send({
    error: { code:'INTERNAL_ERROR',message:'Изменение черновика не выполнено.' },
    requestId:id('req'),retryable:true
  });
}
export async function registerAgentDraftEditRoutes(app: FastifyInstance): Promise<void> {
  app.patch('/api/agent/v1/posts/:postId',{bodyLimit:65536},async(request,reply)=>{
    if (request.url.includes('?')) {
      return safeError(reply,new AgentRegistryError(
        'VALIDATION_ERROR','Параметры URL запрещены.',400));
    }
    const idem=request.headers['idempotency-key'];
    if (typeof idem !== 'string' || !IDENTIFIER.test(idem)) {
      return safeError(reply,new AgentRegistryError(
        'VALIDATION_ERROR','Необходим Idempotency-Key.',400));
    }
    try {
      const postId=(request.params as {postId:string}).postId;
      const done=applyPatch(request,postId,request.body,idem);
      return reply.code(done.replay?200:200).send(done.data);
    }catch(e){return safeError(reply,e);}
  });
}
