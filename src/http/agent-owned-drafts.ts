import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, id } from '../db.js';
import { config } from '../config.js';
import { getOwnerAgent } from '../agent-owner-registry.js';
import { AgentRegistryError } from '../agent-registry-error.js';
import { assertEffectiveAgentGrant } from '../agent-grant-acl.js';
import { parsePage, IDENTIFIER } from './agent-page.js';
import {
  verifiedAgentBearer, respondAgentBearerFailure, AgentBearerFailure
} from './agent-bearer-boundary.js';

type PostRow = {
  id: string; project_id: string; title: string; body: string;
  content_version: number;
};
type VerifiedReader = {
  agentId: string; tokenVersion: number; grantVersion: number;
  tokenScopes: string[];
};
type GrantIds = { projectIds: string[]; accountIds: string[] };
type OwnedPage = { limit: number; cursor: string | null };

function invalidCursor(): never {
  throw new AgentRegistryError('VALIDATION_ERROR','Некорректный cursor.',400);
}

function parseOwnedPage(query: unknown): OwnedPage {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    invalidCursor();
  }
  const params = query as Record<string, unknown>;
  if (Object.keys(params).some(k => k !== 'limit' && k !== 'cursor')) {
    throw new AgentRegistryError('VALIDATION_ERROR','Допустимы только limit и cursor.',400);
  }
  const page = parsePage({ limit: params.limit });
  if (params.cursor === undefined) return {limit:page.limit,cursor:null};
  if (typeof params.cursor !== 'string'
    || !/^[A-Za-z0-9_-]{1,172}\.[A-Za-z0-9_-]{43}$/.test(params.cursor)) {
    invalidCursor();
  }
  return {limit:page.limit,cursor:params.cursor};
}

/** HMAC authenticates the cursor to this agent and current grant version.
 * No post content, access token or provider credential enters the cursor.
 */
function cursorMac(principal: VerifiedReader, postId: string): Buffer {
  return crypto.createHmac('sha256', config.masterKey)
    .update('publikator:a2b3:owned-drafts:v1\0')
    .update(principal.agentId).update('\0')
    .update(String(principal.grantVersion)).update('\0')
    .update(postId).digest();
}
function encodeCursor(principal: VerifiedReader, postId: string): string {
  return Buffer.from(postId,'utf8').toString('base64url')
    + '.' + cursorMac(principal,postId).toString('base64url');
}
function decodeCursor(principal: VerifiedReader, cursor: string | null): string {
  if (cursor === null) return '';
  const parts = cursor.split('.');
  if (parts.length !== 2) invalidCursor();
  const encoded = parts[0] ?? '';
  const mac = parts[1] ?? '';
  const postId = Buffer.from(encoded,'base64url').toString('utf8');
  if (!IDENTIFIER.test(postId)
    || Buffer.from(postId,'utf8').toString('base64url') !== encoded) invalidCursor();
  const actual = Buffer.from(mac,'base64url'), expected = cursorMac(principal,postId);
  if (actual.length !== expected.length
    || actual.toString('base64url') !== mac
    || !crypto.timingSafeEqual(actual,expected)) invalidCursor();
  return postId;
}

/**
 * Post text is private: always filter by immutable agent_draft_ownership,
 * current project/account grants and safe DRAFT lifecycle in SQL BEFORE
 * selecting or returning post text. No arbitrary query filters or output.
 */
const SAFE_DRAFT_WHERE = [
  "o.agent_id=?",
  "p.source_type='agent-api'",
  "p.status='DRAFT'",
  "p.editorial_stage='DRAFT'",
  "p.schedule_mode='MANUAL'",
  'p.scheduled_at IS NULL',
  'p.scheduled_at_utc IS NULL',
  'p.ready_revision_id IS NULL',
  "p.publication_kind='FEED'",
  "p.content_format='TEXT_ONLY'",
  'length(p.title) BETWEEN 1 AND 160',
  'length(p.body) BETWEEN 1 AND 20000',
  'EXISTS (SELECT 1 FROM json_each(?) permitted_project WHERE permitted_project.value=p.project_id)',
  'EXISTS (SELECT 1 FROM post_targets t WHERE t.post_id=p.id)',
  '(SELECT COUNT(*) FROM post_targets t WHERE t.post_id=p.id) <= 20',
  'NOT EXISTS (SELECT 1 FROM media m WHERE m.post_id=p.id)',
  'NOT EXISTS (SELECT 1 FROM content_media cm WHERE cm.post_id=p.id)',
  'NOT EXISTS (SELECT 1 FROM publication_units u JOIN post_targets t ON t.id=u.target_id WHERE t.post_id=p.id)',
  [
    'NOT EXISTS (',
    'SELECT 1 FROM post_targets t',
    'LEFT JOIN social_accounts a ON a.id=t.account_id',
    'WHERE t.post_id=p.id AND (',
    't.enabled<>1 OR a.id IS NULL OR a.enabled<>1',
    "OR t.state<>'PENDING' OR t.attempts<>0",
    'OR t.next_attempt_at IS NOT NULL OR t.external_id IS NOT NULL',
    'OR t.external_url IS NOT NULL OR t.published_at IS NOT NULL',
    'OR t.last_error IS NOT NULL',
    'OR t.override_text IS NOT NULL',
    'OR NOT EXISTS (',
    'SELECT 1 FROM json_each(?) allowed_account',
    'WHERE allowed_account.value=t.account_id',
    ')',
    'OR EXISTS (SELECT 1 FROM target_renditions tr WHERE tr.target_id=t.id)',
    ')',
    ')'
  ].join(' ')
].join(' AND ');

function requireReader(request: FastifyRequest): {
  principal: VerifiedReader; grant: GrantIds
} {
  const principal = verifiedAgentBearer(request);
  const grant = getOwnerAgent(principal.agentId).grant;
  if (grant.status !== 'ACTIVE' || grant.grantVersion !== principal.grantVersion) {
    throw new AgentBearerFailure(401, 'UNAUTHORIZED', 'Разрешения агента устарели.');
  }
  if (!principal.tokenScopes.includes('posts:read')
    || !grant.scopeIds.includes('posts:read')) {
    throw new AgentRegistryError('FORBIDDEN_SCOPE',
      'Отсутствует posts:read для просмотра черновиков.', 403);
  }
  return { principal, grant: {
    projectIds: grant.projectIds, accountIds: grant.accountIds
  } };
}

function safeRowDto(row: PostRow, principal: VerifiedReader) {
  // The SQL query already filters every recipient. Defense-in-depth uses
  // the existing effective ACL again on a concrete, never client-owned postId.
  assertEffectiveAgentGrant({
    agentId: principal.agentId,
    tokenVersion: principal.tokenVersion,
    grantVersion: principal.grantVersion,
    tokenScopes: principal.tokenScopes,
    requiredScope: 'posts:read', projectId: row.project_id, postId: row.id
  });
  const targets = db.prepare([
    'SELECT account_id FROM post_targets',
    'WHERE post_id=? ORDER BY account_id'
  ].join(' ')).all(row.id) as Array<{ account_id: string }>;
  if (targets.length < 1 || targets.length > 20) {
    throw new AgentRegistryError('RESOURCE_DENIED', 'Черновик недоступен.', 403);
  }
  return {
    postId: row.id,
    contentVersion: row.content_version,
    status: 'DRAFT' as const,
    editorialStage: 'DRAFT' as const,
    projectId: row.project_id,
    contentFormat: 'TEXT_ONLY' as const,
    publicationKind: 'FEED' as const,
    internalTitle: row.title,
    bodyPlain: row.body,
    targetAccountIds: targets.map(t => t.account_id),
    mediaAssetIds: [] as string[],
    targetTextOverrides: [] as unknown[],
    schedule: null
  };
}

function listOwnDrafts(request: FastifyRequest, page: OwnedPage) {
  return db.transaction(() => {
    const {principal, grant} = requireReader(request);
    const after = decodeCursor(principal,page.cursor);
    if (!grant.projectIds.length || !grant.accountIds.length) {
      return {items: [], pagination:{limit: page.limit,nextCursor:null}};
    }
    const sql = [
      'SELECT p.id,p.project_id,p.title,p.body,p.content_version',
      'FROM posts p INNER JOIN agent_draft_ownership o ON o.post_id=p.id',
      'WHERE', SAFE_DRAFT_WHERE, 'AND p.id>?',
      'ORDER BY p.id LIMIT ?'
    ].join(' ');
    const rows = db.prepare(sql).all(principal.agentId,
      JSON.stringify(grant.projectIds), JSON.stringify(grant.accountIds),
      after, page.limit+1) as PostRow[];
    const visible=rows.slice(0,page.limit);
    const items=visible.map(row=>safeRowDto(row,principal));
    return {
      items,
      pagination:{
        limit:page.limit,
        nextCursor:rows.length>page.limit
          ? encodeCursor(principal,visible.at(-1)!.id) : null
      }
    };
  })();
}

function getOwnDraft(request: FastifyRequest, postId: string) {
  if (!IDENTIFIER.test(postId)) {
    throw new AgentRegistryError('VALIDATION_ERROR','Некорректный postId.',400);
  }
  return db.transaction(() => {
    const {principal,grant}=requireReader(request);
    const row=db.prepare([
      'SELECT p.id,p.project_id,p.title,p.body,p.content_version',
      'FROM posts p INNER JOIN agent_draft_ownership o ON o.post_id=p.id',
      'WHERE',SAFE_DRAFT_WHERE,'AND p.id=?'
    ].join(' ')).get(principal.agentId,
      JSON.stringify(grant.projectIds),JSON.stringify(grant.accountIds),postId
    ) as PostRow|undefined;
    if (!row) {
      // Never reveal whether a post exists outside this agent/scope.
      throw new AgentRegistryError('RESOURCE_NOT_FOUND','Черновик недоступен.',404);
    }
    return safeRowDto(row,principal);
  })();
}

function safeError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentRegistryError && [
    'VALIDATION_ERROR','FORBIDDEN_SCOPE','RESOURCE_DENIED','RESOURCE_NOT_FOUND'
  ].includes(error.code)) {
    return reply.code(error.status).send({
      error:{code:error.code,message:error.message},requestId:id('req'),retryable:false
    });
  }
  return respondAgentBearerFailure(reply,error);
}

export async function registerAgentOwnedDraftReadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/v1/posts',async(request,reply)=>{
    reply.header('cache-control','no-store');
    try {
      return listOwnDrafts(request,parseOwnedPage(request.query));
    } catch(e) { return safeError(reply,e); }
  });
  app.get('/api/agent/v1/posts/:postId',async(request,reply)=>{
    reply.header('cache-control','no-store');
    if (request.url.includes('?')) {
      return safeError(reply,new AgentRegistryError('VALIDATION_ERROR',
        'Параметры URL здесь не поддерживаются.',400));
    }
    try {
      return getOwnDraft(request,(request.params as {postId:string}).postId);
    } catch(e) { return safeError(reply,e); }
  });
}
