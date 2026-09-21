import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-ew4-009-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'ew4-009-admin-password';
process.env.APP_MASTER_KEY = 'ew4-009-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, id, migrate, nowIso } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
const { createTemplate } = await import('../dist/templates.js');
const { markReadyRevision } = await import('../dist/content-versioning.js');
const { parseRichTextJson } = await import('../dist/rich-text.js');
const { resetIntegrationRateLimitsForTests } = await import('../dist/integration-security.js');
migrate();

const project = db.prepare('SELECT id,slug FROM projects ORDER BY created_at,id LIMIT 1').get();
assert.ok(project);
db.prepare("UPDATE projects SET default_timezone='Europe/Moscow' WHERE id=?").run(project.id);

function account(accountId, platform, name) {
  const now = nowIso();
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,'test-encrypted',1,?,?)`).run(accountId, platform, name, now, now);
}
account('ew4-api-tg', 'telegram', 'API Telegram');
account('ew4-api-vk', 'vk', 'API VK');
db.prepare('INSERT INTO project_default_targets (project_id,account_id,created_at) VALUES (?,?,?)')
  .run(project.id, 'ew4-api-tg', nowIso());

const template = createTemplate({
  key: 'ew4-api-template',
  name: 'EW4 API template',
  projectId: project.id,
  templateType: 'POST',
  bodyRich: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Template snapshot', marks: [{ type: 'bold' }] }] }]
  },
  publicationKind: 'STORY',
  contentFormat: 'STORY_SEQUENCE',
  scheduleMode: 'MANUAL',
  targetAccountIds: ['ew4-api-vk']
});

let app = await buildApp();
await app.ready();

async function login() {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  return String(response.headers['set-cookie']).split(';')[0];
}
let cookie = await login();
const admin = (method, url, payload) => app.inject({
  method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload })
});
const external = (method, url, token, payload, extraHeaders = {}) => app.inject({
  method, url,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
  ...(payload === undefined ? {} : { payload })
});

async function createKey(name, scopes) {
  const response = await admin('POST', '/api/integration-keys', { name, scopes });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

try {
  const anonymousKeys = await app.inject({ method: 'GET', url: '/api/integration-keys' });
  assert.equal(anonymousKeys.statusCode, 401, anonymousKeys.body);

  const full = await createKey('EW4 full', [
    'content:draft:write','content:read','schedule:write','approval:request'
  ]);
  assert.match(full.token, /^pk_[A-Za-z0-9_-]{40,}$/);
  assert.ok(full.key.prefix);
  const stored = db.prepare('SELECT key_hash,scopes_json FROM integration_api_keys WHERE id=?').get(full.key.id);
  assert.match(stored.key_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.key_hash, full.token);
  assert.equal(JSON.stringify(stored).includes(full.token), false);

  const listed = await admin('GET', '/api/integration-keys');
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(JSON.stringify(listed.json()).includes(full.token), false);

  const forbiddenScope = await admin('POST', '/api/integration-keys', {
    name: 'forbidden publish',
    scopes: ['content:draft:write','publish:request']
  });
  assert.equal(forbiddenScope.statusCode, 400, forbiddenScope.body);

  const draftOnly = await createKey('EW4 draft only', ['content:draft:write']);
  const readOnly = await createKey('EW4 read only', ['content:read']);
  const second = await createKey('EW4 second full', [
    'content:draft:write','content:read','schedule:write','approval:request'
  ]);

  const unauth = await external('GET', '/api/integration/v1/drafts', null);
  assert.equal(unauth.statusCode, 401, unauth.body);
  assert.equal(unauth.json().error.code, 'UNAUTHORIZED');

  const scopeDenied = await external('POST', '/api/integration/v1/drafts', readOnly.token, {
    project: project.slug, externalId: 'scope-denied', internalTitle: 'Denied', body: 'Body'
  }, { 'idempotency-key': 'scope-denied' });
  assert.equal(scopeDenied.statusCode, 403, scopeDenied.body);
  assert.equal(scopeDenied.json().error.code, 'SCOPE_REQUIRED');

  const scheduledPayload = {
    project: project.slug,
    externalId: 'scheduled-no-scope',
    internalTitle: 'Scheduled no scope',
    body: '**Scheduled**',
    schedule: { mode: 'AT', at: '2026-10-01T10:00:00' }
  };
  const scheduleDenied = await external('POST', '/api/integration/v1/drafts', draftOnly.token, scheduledPayload, {
    'idempotency-key': 'scheduled-no-scope'
  });
  assert.equal(scheduleDenied.statusCode, 403, scheduleDenied.body);
  assert.equal(scheduleDenied.json().error.code, 'SCOPE_REQUIRED');
  assert.equal(scheduleDenied.json().error.details.scope, 'schedule:write');

  const defaultPayload = {
    project: project.slug,
    externalId: 'api-defaults-001',
    internalTitle: 'API Defaults',
    body: '**Новый модуль**\n[Подробнее](https://example.org)\n> Важно',
    publicationKind: 'FEED',
    contentFormat: 'TEXT_ONLY',
    schedule: { mode: 'AT', at: '2026-10-01T10:00:00' }
  };
  const created = await external('POST', '/api/integration/v1/drafts', full.token, defaultPayload, {
    'idempotency-key': 'idem-defaults-001'
  });
  assert.equal(created.statusCode, 201, created.body);
  const createdBody = created.json();
  assert.equal(createdBody.replay, false);
  const postId = createdBody.post.id;
  assert.equal(createdBody.post.publicationStatus, 'DRAFT');
  assert.equal(createdBody.post.editorialStage, 'DRAFT');
  assert.equal(createdBody.post.contentVersion, 1);
  assert.equal(createdBody.post.schedule.timezone, 'Europe/Moscow');
  assert.equal(createdBody.post.schedule.at, '2026-10-01T07:00:00.000Z');
  assert.deepEqual(createdBody.post.targets.map((item) => item.accountId), ['ew4-api-tg']);
  const createdAst = createdBody.post.bodyRich;
  assert.ok(JSON.stringify(createdAst).includes('"type":"bold"'));
  assert.ok(JSON.stringify(createdAst).includes('"type":"link"'));
  assert.ok(JSON.stringify(createdAst).includes('"type":"blockquote"'));
  assert.deepEqual(
    db.prepare('SELECT content_version,actor_source FROM content_revisions WHERE post_id=? ORDER BY content_version').all(postId),
    [{ content_version: 1, actor_source: 'integration_api' }]
  );

  const replay = await external('POST', '/api/integration/v1/drafts', full.token, {
    contentFormat: 'TEXT_ONLY',
    internalTitle: 'API Defaults',
    externalId: 'api-defaults-001',
    schedule: { at: '2026-10-01T10:00:00', mode: 'AT' },
    publicationKind: 'FEED',
    body: '**Новый модуль**\n[Подробнее](https://example.org)\n> Важно',
    project: project.slug
  }, { 'idempotency-key': 'idem-defaults-001' });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replay, true);
  assert.equal(replay.json().post.id, postId);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='integration-api' AND source_ref=?")
    .get(JSON.stringify([full.key.id, 'idem-defaults-001'])).count, 1);

  const idemConflict = await external('POST', '/api/integration/v1/drafts', full.token, {
    ...defaultPayload, internalTitle: 'Different payload'
  }, { 'idempotency-key': 'idem-defaults-001' });
  assert.equal(idemConflict.statusCode, 409, idemConflict.body);
  assert.equal(idemConflict.json().error.code, 'IDEMPOTENCY_CONFLICT');

  const otherKeySameIdem = await external('POST', '/api/integration/v1/drafts', second.token, defaultPayload, {
    'idempotency-key': 'idem-defaults-001'
  });
  assert.equal(otherKeySameIdem.statusCode, 201, otherKeySameIdem.body);
  assert.notEqual(otherKeySameIdem.json().post.id, postId);

  const templateCreate = await external('POST', '/api/integration/v1/drafts', full.token, {
    project: project.slug,
    externalId: 'api-template-001',
    templateKey: template.key,
    internalTitle: 'Template API'
  }, { 'idempotency-key': 'idem-template-001' });
  assert.equal(templateCreate.statusCode, 201, templateCreate.body);
  assert.equal(templateCreate.json().post.body, 'Template snapshot');
  assert.equal(templateCreate.json().post.publicationKind, 'STORY');
  assert.equal(templateCreate.json().post.contentFormat, 'STORY_SEQUENCE');
  assert.deepEqual(templateCreate.json().post.targets.map((item) => item.accountId), ['ew4-api-vk']);

  const explicit = await external('POST', '/api/integration/v1/drafts', full.token, {
    project: project.slug,
    externalId: 'api-explicit-001',
    templateKey: template.key,
    internalTitle: 'Explicit API',
    body: '**Explicit**',
    publicationKind: 'SHORT',
    contentFormat: 'VERTICAL_VIDEO',
    targets: [{ accountId: 'ew4-api-tg' }],
    overrides: { telegram: '**Telegram override**' }
  }, { 'idempotency-key': 'idem-explicit-001' });
  assert.equal(explicit.statusCode, 201, explicit.body);
  assert.equal(explicit.json().post.body, 'Explicit');
  assert.equal(explicit.json().post.publicationKind, 'SHORT');
  assert.equal(explicit.json().post.contentFormat, 'VERTICAL_VIDEO');
  assert.deepEqual(explicit.json().post.targets.map((item) => item.accountId), ['ew4-api-tg']);
  assert.equal(explicit.json().post.targets[0].override.body, 'Telegram override');
  assert.ok(JSON.stringify(explicit.json().post.targets[0].override.bodyRich).includes('"type":"bold"'));

  const lifecycleBypass = await external('POST', '/api/integration/v1/drafts', full.token, {
    project: project.slug, externalId: 'bypass-001', internalTitle: 'Bypass', body: 'Body', status: 'READY'
  }, { 'idempotency-key': 'bypass-001' });
  assert.equal(lifecycleBypass.statusCode, 400, lifecycleBypass.body);
  assert.equal(lifecycleBypass.json().error.code, 'VALIDATION_ERROR');

  const list = await external('GET', '/api/integration/v1/drafts?limit=1&offset=0', full.token);
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().items.length, 1);
  assert.equal(list.json().limit, 1);
  assert.equal(list.json().offset, 0);
  assert.equal(list.json().nextOffset, 1);
  assert.ok(list.json().total >= 4);
  assert.equal(JSON.stringify(list.json()).includes('key_hash'), false);
  assert.equal(JSON.stringify(list.json()).includes(full.token), false);

  const read = await external('GET', `/api/integration/v1/drafts/${postId}`, full.token);
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().id, postId);
  assert.equal(read.json().contentVersion, 1);

  const initialRevision = db.prepare('SELECT id FROM content_revisions WHERE post_id=? AND content_version=1').get(postId);
  markReadyRevision(postId, 1, initialRevision.id);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(postId).status, 'READY');

  const updated = await external('PATCH', `/api/integration/v1/drafts/${postId}`, full.token, {
    expectedContentVersion: 1,
    body: '**Updated API body**'
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().post.contentVersion, 2);
  assert.equal(updated.json().post.publicationStatus, 'DRAFT');
  assert.equal(updated.json().post.editorialStage, 'DRAFT');
  assert.equal(db.prepare('SELECT ready_revision_id FROM posts WHERE id=?').get(postId).ready_revision_id, null);
  assert.deepEqual(
    db.prepare('SELECT content_version,actor_source FROM content_revisions WHERE post_id=? ORDER BY content_version').all(postId),
    [
      { content_version: 1, actor_source: 'integration_api' },
      { content_version: 2, actor_source: 'integration_api' }
    ]
  );

  const stale = await external('PATCH', `/api/integration/v1/drafts/${postId}`, full.token, {
    expectedContentVersion: 1,
    internalTitle: 'Stale update'
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error.code, 'CONTENT_VERSION_CONFLICT');

  const scheduleUpdateDenied = await external('PATCH', `/api/integration/v1/drafts/${postId}`, draftOnly.token, {
    expectedContentVersion: 2,
    schedule: { mode: 'QUEUE' }
  });
  assert.equal(scheduleUpdateDenied.statusCode, 403, scheduleUpdateDenied.body);
  assert.equal(scheduleUpdateDenied.json().error.code, 'SCOPE_REQUIRED');

  const review = await external('POST', `/api/integration/v1/drafts/${postId}/request-review`, full.token, {
    expectedContentVersion: 2
  });
  assert.equal(review.statusCode, 200, review.body);
  assert.equal(review.json().post.editorialStage, 'IN_REVIEW');
  assert.equal(review.json().post.publicationStatus, 'DRAFT');
  assert.equal(review.json().post.contentVersion, 3);

  const updateBypass = await external('PATCH', `/api/integration/v1/drafts/${postId}`, full.token, {
    expectedContentVersion: 3,
    publicationStatus: 'PUBLISHED'
  });
  assert.equal(updateBypass.statusCode, 400, updateBypass.body);
  assert.equal(updateBypass.json().error.code, 'VALIDATION_ERROR');

  db.prepare("UPDATE posts SET status='PUBLISHED' WHERE id=?").run(explicit.json().post.id);
  const immutable = await external('PATCH', `/api/integration/v1/drafts/${explicit.json().post.id}`, full.token, {
    expectedContentVersion: 1, body: 'Cannot edit'
  });
  assert.equal(immutable.statusCode, 409, immutable.body);
  assert.equal(immutable.json().error.code, 'IMMUTABLE_POST');

  const openapi = await external('GET', '/api/integration/v1/openapi.json', full.token);
  assert.equal(openapi.statusCode, 200, openapi.body);
  assert.equal(openapi.json().openapi, '3.1.0');
  const openapiText = JSON.stringify(openapi.json());
  assert.ok(openapiText.includes('/drafts/{id}/request-review'));
  assert.equal(openapiText.includes('publish-now'), false);
  assert.equal(openapiText.includes('media/upload'), false);

  await app.close();
  app = await buildApp();
  await app.ready();
  cookie = await login();
  resetIntegrationRateLimitsForTests();
  const restartReplay = await external('POST', '/api/integration/v1/drafts', full.token, defaultPayload, {
    'idempotency-key': 'idem-defaults-001'
  });
  assert.equal(restartReplay.statusCode, 200, restartReplay.body);
  assert.equal(restartReplay.json().post.id, postId);
  assert.equal(restartReplay.json().replay, true);

  resetIntegrationRateLimitsForTests();
  for (let index = 0; index < 60; index += 1) {
    const response = await external('GET', '/api/integration/v1/openapi.json', readOnly.token);
    assert.equal(response.statusCode, 200, `rate call ${index + 1}: ${response.body}`);
  }
  const limited = await external('GET', '/api/integration/v1/openapi.json', readOnly.token);
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  resetIntegrationRateLimitsForTests();

  const auditRows = db.prepare("SELECT event_type,data_json FROM publication_events WHERE event_type LIKE 'api.%' ORDER BY created_at").all();
  assert.ok(auditRows.some((row) => row.event_type === 'api.draft_created'));
  assert.ok(auditRows.some((row) => row.event_type === 'api.draft_updated'));
  assert.ok(auditRows.some((row) => row.event_type === 'api.review_requested'));
  const auditJson = JSON.stringify(auditRows);
  assert.equal(auditJson.includes(full.token), false);
  assert.equal(auditJson.includes('Authorization'), false);
  assert.equal(auditJson.includes(defaultPayload.body), false);
  assert.ok(auditJson.includes(full.key.prefix));

  const rotated = await admin('POST', `/api/integration-keys/${full.key.id}/rotate`, {});
  assert.equal(rotated.statusCode, 200, rotated.body);
  const rotatedBody = rotated.json();
  assert.match(rotatedBody.token, /^pk_/);
  assert.notEqual(rotatedBody.token, full.token);
  const oldAfterRotate = await external('GET', '/api/integration/v1/openapi.json', full.token);
  assert.equal(oldAfterRotate.statusCode, 401, oldAfterRotate.body);
  const newAfterRotate = await external('GET', '/api/integration/v1/openapi.json', rotatedBody.token);
  assert.equal(newAfterRotate.statusCode, 200, newAfterRotate.body);

  const revoked = await admin('POST', `/api/integration-keys/${rotatedBody.key.id}/revoke`, {});
  assert.equal(revoked.statusCode, 200, revoked.body);
  const afterRevoke = await external('GET', '/api/integration/v1/openapi.json', rotatedBody.token);
  assert.equal(afterRevoke.statusCode, 401, afterRevoke.body);

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'EW4-009',
    KEY_CREATE_ONE_TIME_TOKEN: 'PASS',
    KEY_HASH_ONLY_STORAGE: 'PASS',
    KEY_ROTATE: 'PASS',
    KEY_REVOKE: 'PASS',
    BEARER_AUTH: 'PASS',
    SCOPE_ENFORCEMENT: 'PASS',
    RATE_LIMIT: 'PASS',
    DRAFT_CREATE: 'PASS',
    TEMPLATE_KEY: 'PASS',
    PORTABLE_RICH: 'PASS',
    TARGET_DEFAULT_FALLBACK: 'PASS',
    EXPLICIT_TARGET_OVERRIDE: 'PASS',
    SCHEDULE_SCOPE: 'PASS',
    PROJECT_TIMEZONE_FALLBACK: 'PASS',
    IDEMPOTENCY_SAME_PAYLOAD: 'PASS',
    IDEMPOTENCY_CONFLICT: 'PASS',
    IDEMPOTENCY_RESTART_SAFE: 'PASS',
    READ: 'PASS',
    PAGINATION: 'PASS',
    UPDATE_VERSIONING: 'PASS',
    STALE_UPDATE_409: 'PASS',
    REQUEST_REVIEW: 'PASS',
    PUBLISH_BYPASS_BLOCKED: 'PASS',
    AUDIT_SECRET_FREE: 'PASS',
    STRUCTURED_ERRORS: 'PASS',
    OPENAPI: 'PASS'
  }, null, 2));
} finally {
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
