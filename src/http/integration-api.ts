import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, event } from '../db.js';
import {
  authenticateIntegrationApiKey,
  consumeIntegrationRateLimit,
  createIntegrationApiKey,
  listIntegrationApiKeys,
  revokeIntegrationApiKey,
  rotateIntegrationApiKey,
  type ApiKeyMetadata,
  type IntegrationScope
} from '../integration-security.js';
import {
  applyContentPlanV3,
  applyResolvedTargetsAndOverrides,
  EditorialDraftContractError,
  resolveEditorialDraftV3,
  resolveEditorialUpdateV3,
  type EditorialDraftContractInput,
  type V3Validation
} from '../content-plan-v3.js';
import {
  ContentConflictError,
  ContentImmutableError,
  commitContentEdit
} from '../content-versioning.js';
import { requestReviewPost } from '../editorial-lifecycle.js';
import { parseRichTextJson } from '../rich-text.js';

const SOURCE_TYPE = 'integration-api';
const BODY_LIMIT = 256 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const UI_SCOPES = new Set<IntegrationScope>([
  'content:draft:write',
  'content:read',
  'schedule:write',
  'approval:request'
]);
const IMMUTABLE = new Set(['PUBLISHING','PARTIAL','PUBLISHED']);

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required');
  return value as Record<string, unknown>;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, details: Record<string, unknown> = {}): FastifyReply {
  return reply.code(status).send({ error: { code, message, details } });
}

function bearerToken(request: FastifyRequest): string | null {
  const raw = request.headers.authorization;
  if (typeof raw !== 'string') return null;
  const match = /^Bearer\s+(pk_[A-Za-z0-9_-]{40,})$/.exec(raw.trim());
  return match?.[1] ?? null;
}

function requireScope(key: ApiKeyMetadata, scope: IntegrationScope, reply: FastifyReply): boolean {
  if (key.scopes.includes(scope)) return true;
  sendError(reply, 403, 'SCOPE_REQUIRED', 'API key requires scope ' + scope, { scope });
  return false;
}

function authenticate(request: FastifyRequest, reply: FastifyReply, scope?: IntegrationScope): ApiKeyMetadata | null {
  const token = bearerToken(request);
  if (!token) {
    sendError(reply, 401, 'UNAUTHORIZED', 'Valid Bearer API key required');
    return null;
  }
  let key: ApiKeyMetadata;
  try {
    key = authenticateIntegrationApiKey(token);
  } catch {
    sendError(reply, 401, 'UNAUTHORIZED', 'Invalid or revoked API key');
    return null;
  }
  const rate = consumeIntegrationRateLimit(key.id);
  if (!rate.allowed) {
    reply.header('Retry-After', String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
    sendError(reply, 429, 'RATE_LIMITED', 'Integration API rate limit exceeded', { retryAfterMs: rate.retryAfterMs });
    return null;
  }
  if (scope && !requireScope(key, scope, reply)) return null;
  return key;
}

function issueScopes(raw: unknown): IntegrationScope[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== 'string')) {
    throw new Error('scopes must be a non-empty array');
  }
  const scopes = [...new Set(raw as string[])];
  for (const scope of scopes) {
    if (!UI_SCOPES.has(scope as IntegrationScope)) throw new Error('scope cannot be issued from ordinary UI: ' + scope);
  }
  return scopes as IntegrationScope[];
}

function idempotencyFrom(request: FastifyRequest): string | null {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value) ? value : null;
}

function sourceRef(keyId: string, idempotencyKey: string): string {
  return JSON.stringify([keyId, idempotencyKey]);
}

function auditIdempotency(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

function integrationRow(postId: string): any | undefined {
  return db.prepare("SELECT p.*,pr.slug AS project_slug,pr.name AS project_name FROM posts p JOIN projects pr ON pr.id=p.project_id WHERE p.id=? AND p.source_type='integration-api'").get(postId) as any;
}

function integrationTargets(postId: string): any[] {
  const rows = db.prepare("SELECT pt.account_id,a.platform,a.name,tr.text_rich_json,tr.text_plain FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id LEFT JOIN target_renditions tr ON tr.target_id=pt.id WHERE pt.post_id=? AND pt.enabled=1 ORDER BY a.platform,a.name,a.id").all(postId) as any[];
  return rows.map((row) => ({
    accountId: row.account_id,
    platform: row.platform,
    name: row.name,
    override: row.text_rich_json ? {
      body: row.text_plain ?? '',
      bodyRich: parseRichTextJson(String(row.text_rich_json))
    } : null
  }));
}

function integrationDto(postId: string): any | undefined {
  const row = integrationRow(postId);
  if (!row) return undefined;
  return {
    id: row.id,
    project: row.project_slug,
    projectName: row.project_name,
    externalId: row.source_revision ?? null,
    internalTitle: row.title,
    body: row.body,
    bodyRich: parseRichTextJson(String(row.body_rich_json)),
    tags: (() => { try { const value = JSON.parse(String(row.tags_json ?? '[]')); return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []; } catch { return []; } })(),
    sourceNote: row.source_note ?? null,
    publicationKind: row.publication_kind,
    contentFormat: row.content_format,
    targets: integrationTargets(postId),
    schedule: { mode: row.schedule_mode, at: row.scheduled_at_utc ?? null, timezone: row.schedule_timezone ?? null },
    editorialStage: row.editorial_stage,
    publicationStatus: row.status,
    contentVersion: row.content_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rejectLifecycleBypass(body: Record<string, unknown>): string | null {
  for (const field of ['status','editorialStage','publicationStatus','ready','publish','publishNow']) {
    if (Object.prototype.hasOwnProperty.call(body, field)) return field;
  }
  return null;
}

function mutationError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof EditorialDraftContractError) {
    if (error.issues.length === 1 && error.issues[0] === 'post not found') return sendError(reply, 404, 'NOT_FOUND', 'Draft not found');
    return sendError(reply, 400, 'VALIDATION_ERROR', error.message, { issues: error.issues });
  }
  if (error instanceof ContentConflictError) return sendError(reply, 409, 'CONTENT_VERSION_CONFLICT', error.message);
  if (error instanceof ContentImmutableError) return sendError(reply, 409, 'IMMUTABLE_POST', error.message);
  return sendError(reply, 400, 'VALIDATION_ERROR', error instanceof Error ? error.message : String(error));
}

function singleNewValidation(keyId: string, row: ReturnType<typeof resolveEditorialDraftV3>): V3Validation {
  return {
    version: 3,
    sourceId: keyId,
    fileSha256: row.payloadHash,
    format: 'csv',
    canApply: true,
    summary: { totalRows: 1, newRows: 1, updateRows: 0, unchangedRows: 0, conflicts: 0, requests: 0, errors: 0 },
    rows: [{ rowNumber: 1, classification: 'NEW', errors: [], normalized: row }]
  };
}

function openApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Publikator Integration API', version: '1.0.0' },
    servers: [{ url: '/api/integration/v1' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'pk_...' } },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              required: ['code','message','details'],
              properties: {
                code: { type: 'string' }, message: { type: 'string' },
                details: { type: 'object', additionalProperties: true }
              }
            }
          }
        }
      }
    },
    paths: {
      '/openapi.json': { get: { summary: 'Integration API OpenAPI contract' } },
      '/drafts': {
        post: { summary: 'Create idempotent editable DRAFT', parameters: [{ name: 'Idempotency-Key', in: 'header', required: true }] },
        get: { summary: 'List Integration API posts', parameters: [{ name: 'limit', in: 'query' }, { name: 'offset', in: 'query' }] }
      },
      '/drafts/{id}': {
        get: { summary: 'Read one Integration API post' },
        patch: { summary: 'Update editable DRAFT using expectedContentVersion' }
      },
      '/drafts/{id}/request-review': { post: { summary: 'Move editable DRAFT to IN_REVIEW' } }
    }
  };
}

export async function registerIntegrationApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/integration-keys', async () => ({ keys: listIntegrationApiKeys() }));
  app.post('/api/integration-keys', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    try {
      const body = bodyObject(request.body);
      return reply.code(201).send(createIntegrationApiKey(String(body.name ?? '').trim(), issueScopes(body.scopes)));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post('/api/integration-keys/:id/rotate', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    try { return rotateIntegrationApiKey((request.params as { id: string }).id); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/api/integration-keys/:id/revoke', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    try { return { key: revokeIntegrationApiKey((request.params as { id: string }).id) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get('/api/integration/v1/openapi.json', async (request, reply) => {
    if (!authenticate(request, reply)) return reply;
    return openApiDocument();
  });

  app.post('/api/integration/v1/drafts', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const key = authenticate(request, reply, 'content:draft:write');
    if (!key) return reply;
    const idem = idempotencyFrom(request);
    if (!idem) return sendError(reply, 400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key header is required and must match [A-Za-z0-9._:-]{1,128}');
    let body: Record<string, unknown>;
    try { body = bodyObject(request.body); }
    catch (error) { return sendError(reply, 400, 'VALIDATION_ERROR', error instanceof Error ? error.message : String(error)); }
    const bypass = rejectLifecycleBypass(body);
    if (bypass) return sendError(reply, 400, 'VALIDATION_ERROR', 'Lifecycle/publication field is not writable by Integration API', { field: bypass });
    const externalId = typeof body.externalId === 'string' ? body.externalId.trim() : '';
    let normalized: ReturnType<typeof resolveEditorialDraftV3>;
    try { normalized = resolveEditorialDraftV3(body as EditorialDraftContractInput, { externalId: idem, sourceRevision: externalId }); }
    catch (error) { return mutationError(reply, error); }
    if (normalized.scheduleMode !== 'MANUAL' && !requireScope(key, 'schedule:write', reply)) return reply;

    const ref = sourceRef(key.id, idem);
    const existing = db.prepare("SELECT id,source_payload_hash FROM posts WHERE source_type='integration-api' AND source_ref=?").get(ref) as { id: string; source_payload_hash: string | null } | undefined;
    if (existing) {
      if (existing.source_payload_hash !== normalized.payloadHash) return sendError(reply, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different canonical payload');
      return reply.code(200).send({ replay: true, post: integrationDto(existing.id) });
    }
    try {
      const applied = applyContentPlanV3(singleNewValidation(key.id, normalized), { actorSource: 'integration_api', sourceTypeOverride: SOURCE_TYPE });
      const postId = applied.postIds[0]!;
      event({
        postId, type: 'api.draft_created', message: 'Integration API draft created',
        data: { apiKeyId: key.id, prefix: key.prefix, postId, contentVersion: 1, idempotencyKeyHashPrefix: auditIdempotency(idem) }
      });
      return reply.code(201).send({ replay: false, post: integrationDto(postId) });
    } catch (error) {
      const raced = db.prepare("SELECT id,source_payload_hash FROM posts WHERE source_type='integration-api' AND source_ref=?").get(ref) as { id: string; source_payload_hash: string | null } | undefined;
      if (raced) {
        if (raced.source_payload_hash === normalized.payloadHash) return reply.code(200).send({ replay: true, post: integrationDto(raced.id) });
        return sendError(reply, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was concurrently used with a different canonical payload');
      }
      return mutationError(reply, error);
    }
  });

  app.get('/api/integration/v1/drafts', async (request, reply) => {
    const key = authenticate(request, reply, 'content:read');
    if (!key) return reply;
    const query = request.query as { limit?: string; offset?: string };
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'limit must be 1..100 and offset must be >= 0');
    }
    const total = Number((db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='integration-api'").get() as { count: number }).count);
    const ids = db.prepare("SELECT id FROM posts WHERE source_type='integration-api' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?").all(limit, offset) as Array<{ id: string }>;
    const items = ids.map((row) => integrationDto(row.id));
    return { items, limit, offset, nextOffset: offset + items.length < total ? offset + items.length : null, total };
  });

  app.get('/api/integration/v1/drafts/:id', async (request, reply) => {
    const key = authenticate(request, reply, 'content:read');
    if (!key) return reply;
    const post = integrationDto((request.params as { id: string }).id);
    if (!post) return sendError(reply, 404, 'NOT_FOUND', 'Draft not found');
    return post;
  });

  app.patch('/api/integration/v1/drafts/:id', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const key = authenticate(request, reply, 'content:draft:write');
    if (!key) return reply;
    const params = request.params as { id: string };
    const current = integrationRow(params.id);
    if (!current) return sendError(reply, 404, 'NOT_FOUND', 'Draft not found');
    if (IMMUTABLE.has(current.status)) return sendError(reply, 409, 'IMMUTABLE_POST', 'Post is immutable after publication begins');
    let body: Record<string, unknown>;
    try { body = bodyObject(request.body); }
    catch (error) { return sendError(reply, 400, 'VALIDATION_ERROR', error instanceof Error ? error.message : String(error)); }
    const bypass = rejectLifecycleBypass(body);
    if (bypass) return sendError(reply, 400, 'VALIDATION_ERROR', 'Lifecycle/publication field is not writable by Integration API', { field: bypass });
    if (Object.prototype.hasOwnProperty.call(body, 'schedule') && !requireScope(key, 'schedule:write', reply)) return reply;
    const expected = Number(body.expectedContentVersion);
    if (!Number.isInteger(expected) || expected < 1) return sendError(reply, 400, 'VALIDATION_ERROR', 'expectedContentVersion is required');
    try {
      const resolved = resolveEditorialUpdateV3(params.id, body as EditorialDraftContractInput);
      const committed = commitContentEdit(params.id, expected, 'integration_api', () => {
        db.prepare('UPDATE posts SET title=?,body=?,body_rich_json=?,tags_json=?,source_note=?,publication_kind=?,content_format=?,schedule_mode=?,scheduled_at=?,scheduled_at_utc=?,schedule_timezone=? WHERE id=?')
          .run(resolved.title, resolved.body, resolved.bodyRichJson, JSON.stringify(resolved.tags), resolved.sourceNote,
            resolved.publicationKind, resolved.contentFormat, resolved.scheduleMode, resolved.scheduledAt, resolved.scheduledAt, resolved.scheduleTimezone, params.id);
        applyResolvedTargetsAndOverrides(params.id, 'EXPLICIT', resolved.targets, resolved.overrides);
      });
      event({
        postId: params.id, type: 'api.draft_updated', message: 'Integration API draft updated',
        data: { apiKeyId: key.id, prefix: key.prefix, postId: params.id, contentVersion: committed.contentVersion }
      });
      return { post: integrationDto(params.id) };
    } catch (error) { return mutationError(reply, error); }
  });

  app.post('/api/integration/v1/drafts/:id/request-review', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const key = authenticate(request, reply, 'approval:request');
    if (!key) return reply;
    const params = request.params as { id: string };
    const current = integrationRow(params.id);
    if (!current) return sendError(reply, 404, 'NOT_FOUND', 'Draft not found');
    if (IMMUTABLE.has(current.status)) return sendError(reply, 409, 'IMMUTABLE_POST', 'Post is immutable after publication begins');
    let body: Record<string, unknown>;
    try { body = bodyObject(request.body); }
    catch (error) { return sendError(reply, 400, 'VALIDATION_ERROR', error instanceof Error ? error.message : String(error)); }
    const expected = Number(body.expectedContentVersion);
    if (!Number.isInteger(expected) || expected < 1) return sendError(reply, 400, 'VALIDATION_ERROR', 'expectedContentVersion is required');
    try {
      const result = requestReviewPost(params.id, expected, 'integration_api');
      event({
        postId: params.id, type: 'api.review_requested', message: 'Integration API review requested',
        data: { apiKeyId: key.id, prefix: key.prefix, postId: params.id, contentVersion: result.contentVersion }
      });
      return { post: integrationDto(params.id) };
    } catch (error) { return mutationError(reply, error); }
  });
}
