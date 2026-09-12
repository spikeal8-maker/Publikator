import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-content-v3-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'content-v3-ci-password';
process.env.APP_MASTER_KEY = 'content-v3-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate } = await import('../dist/db.js');
const { commitContentEdit } = await import('../dist/content-versioning.js');
const { buildApp } = await import('../dist/app.js');
const { parseContentPlanV3, validateContentPlanV3, applyContentPlanV3 } = await import('../dist/content-plan-v3.js');
migrate();
const app = await buildApp();
await app.ready();

const columns = [
  'schema_version','external_id','action','project','template_key','internal_title','body',
  'publication_kind','content_format','schedule_mode','scheduled_at','timezone','targets',
  'telegram_body','vk_body','max_body','instagram_body','media','tags','source_note','source_revision'
];

function csv({
  externalId = 'post-001', action = 'UPSERT', body = 'First body', revision = 'rev-1',
  contentFormat = 'IMAGE', targets = [], telegramBody = '', title = 'Imported title'
} = {}) {
  const values = [
    '3', externalId, action, 'main', '', title, body, 'FEED', contentFormat,
    'MANUAL', '', 'UTC', JSON.stringify(targets), telegramBody, '', '', '', '', '', '', revision
  ];
  const encoded = values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(';');
  return Buffer.from('\uFEFF' + columns.join(';') + '\r\n' + encoded + '\r\n');
}

async function preview(buffer, source = 'sheet-alpha') {
  return validateContentPlanV3(await parseContentPlanV3('content.csv', buffer), source);
}

function insertAccount(id, name) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?, 'telegram', ?, 'encrypted-test', 1, ?, ?)`).run(id, name, now, now);
}

try {
  assert.equal(Number(db.pragma('user_version', { simple: true })), 6);
  const postColumns = db.prepare('PRAGMA table_info(posts)').all().map((row) => row.name);
  for (const name of ['source_type','source_ref','source_revision','source_payload_hash','source_batch_id','imported_at','imported_content_version']) {
    assert.ok(postColumns.includes(name), name);
  }

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ method: 'GET', url: '/api/content-plan/schema', headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/content-plan/v2/schema', headers: { cookie } })).statusCode, 404);
  const v3Schema = await app.inject({ method: 'GET', url: '/api/content-plan/v3/schema', headers: { cookie } });
  assert.equal(v3Schema.statusCode, 200);
  assert.equal(v3Schema.json().version, 3);

  let validation = await preview(csv());
  assert.equal(validation.rows[0].classification, 'NEW');
  assert.equal(validation.canApply, true);
  let result = applyContentPlanV3(validation);
  assert.equal(result.created, 1);

  let rows = db.prepare("SELECT * FROM posts WHERE source_type='content-plan-v3' ORDER BY created_at,id").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content_version, 1);
  assert.equal(rows[0].imported_content_version, 1);
  assert.match(rows[0].source_payload_hash, /^[a-f0-9]{64}$/);

  validation = await preview(csv());
  assert.equal(validation.rows[0].classification, 'UNCHANGED');
  result = applyContentPlanV3(validation);
  assert.equal(result.unchanged, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source_type='content-plan-v3'").get().n, 1);

  validation = await preview(csv({ body: 'Changed but reused revision', revision: 'rev-1' }));
  assert.equal(validation.rows[0].classification, 'ERROR');
  assert.equal(validation.canApply, false);
  assert.match(validation.rows[0].errors.join(' '), /source_revision/);

  validation = await preview(csv({ revision: 'rev-2' }));
  assert.equal(validation.rows[0].classification, 'UNCHANGED');
  applyContentPlanV3(validation);
  rows = db.prepare("SELECT * FROM posts WHERE source_type='content-plan-v3' ORDER BY created_at,id").all();
  assert.equal(rows[0].source_revision, 'rev-2');
  assert.equal(rows[0].content_version, 1);
  assert.equal(rows[0].imported_content_version, 1);

  validation = await preview(csv({ body: 'Second body', revision: 'rev-3' }));
  assert.equal(validation.rows[0].classification, 'UPDATE');
  result = applyContentPlanV3(validation);
  assert.equal(result.updated, 1);
  rows = db.prepare("SELECT * FROM posts WHERE source_type='content-plan-v3' ORDER BY created_at,id").all();
  assert.equal(rows[0].body, 'Second body');
  assert.equal(rows[0].content_version, 2);
  assert.equal(rows[0].imported_content_version, 2);

  const postId = rows[0].id;
  commitContentEdit(postId, 2, () => db.prepare("UPDATE posts SET body='Local edit' WHERE id=?").run(postId));
  validation = await preview(csv({ body: 'Third body', revision: 'rev-4' }));
  assert.equal(validation.rows[0].classification, 'CONFLICT');
  assert.equal(validation.canApply, false);
  assert.equal(db.prepare('SELECT body FROM posts WHERE id=?').get(postId).body, 'Local edit');

  const otherSource = await preview(csv({ body: 'Other source body' }), 'sheet-beta');
  assert.equal(otherSource.rows[0].classification, 'NEW');
  applyContentPlanV3(otherSource);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source_type='content-plan-v3'").get().n, 2);

  insertAccount('tg-dup-1', 'Duplicate');
  insertAccount('tg-dup-2', 'Duplicate');
  const ambiguous = await preview(csv({ externalId: 'ambiguous-1', targets: [{ platform: 'telegram', name: 'Duplicate' }] }), 'sheet-targets');
  assert.equal(ambiguous.rows[0].classification, 'ERROR');
  assert.match(ambiguous.rows[0].errors.join(' '), /ambiguous account/);

  insertAccount('tg-a', 'Channel A');
  insertAccount('tg-b', 'Channel B');
  const multiTarget = await preview(csv({
    externalId: 'multi-target-1',
    targets: [{ accountId: 'tg-a' }, { accountId: 'tg-b' }],
    telegramBody: 'Shared Telegram override'
  }), 'sheet-targets');
  assert.equal(multiTarget.rows[0].classification, 'NEW');
  const multiResult = applyContentPlanV3(multiTarget);
  const selectedOverrides = db.prepare(`SELECT account_id,override_text FROM post_targets
    WHERE post_id=? AND enabled=1 ORDER BY account_id`).all(multiResult.postIds[0]);
  assert.deepEqual(selectedOverrides, [
    { account_id: 'tg-a', override_text: 'Shared Telegram override' },
    { account_id: 'tg-b', override_text: 'Shared Telegram override' }
  ]);

  const carousel = await preview(csv({ externalId: 'carousel-1', contentFormat: 'CAROUSEL' }), 'sheet-formats');
  assert.equal(carousel.rows[0].classification, 'ERROR');
  assert.match(carousel.rows[0].errors.join(' '), /content_format=IMAGE/);

  const archiveSeed = await preview(csv({ externalId: 'archive-1', body: 'Archive me', revision: 'rev-1' }), 'sheet-actions');
  const archiveCreate = applyContentPlanV3(archiveSeed);
  const archiveId = archiveCreate.postIds[0];
  let archivePreview = await preview(csv({ externalId: 'archive-1', action: 'ARCHIVE', revision: 'rev-2' }), 'sheet-actions');
  assert.equal(archivePreview.rows[0].classification, 'ARCHIVE_REQUEST');
  assert.equal(archivePreview.canApply, true);
  applyContentPlanV3(archivePreview);
  let archiveRow = db.prepare('SELECT editorial_stage,content_version,imported_content_version FROM posts WHERE id=?').get(archiveId);
  assert.deepEqual(archiveRow, { editorial_stage: 'ARCHIVED', content_version: 2, imported_content_version: 2 });

  archivePreview = await preview(csv({ externalId: 'archive-1', action: 'ARCHIVE', revision: 'rev-2' }), 'sheet-actions');
  assert.equal(archivePreview.rows[0].classification, 'UNCHANGED');
  applyContentPlanV3(archivePreview);
  archiveRow = db.prepare('SELECT editorial_stage,content_version,imported_content_version FROM posts WHERE id=?').get(archiveId);
  assert.deepEqual(archiveRow, { editorial_stage: 'ARCHIVED', content_version: 2, imported_content_version: 2 });

  const immutableSeed = await preview(csv({ externalId: 'immutable-1', body: 'Published source', revision: 'rev-1' }), 'sheet-actions');
  const immutableCreate = applyContentPlanV3(immutableSeed);
  const immutableId = immutableCreate.postIds[0];
  db.prepare("UPDATE posts SET status='PUBLISHED' WHERE id=?").run(immutableId);
  const immutableArchive = await preview(csv({ externalId: 'immutable-1', action: 'ARCHIVE', revision: 'rev-2' }), 'sheet-actions');
  assert.equal(immutableArchive.rows[0].classification, 'ERROR');
  assert.equal(immutableArchive.canApply, false);
  assert.match(immutableArchive.rows[0].errors.join(' '), /status=PUBLISHED/);

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'M0-003',
    schemaVersion: 6,
    idempotent: true,
    sourcePayloadHash: true,
    sourceRevisionReuseRejected: true,
    update: true,
    conflict: true,
    sourceScopedIdentity: true,
    ambiguousAccountRejected: true,
    platformOverrideFanout: true,
    imageOnlyFoundation: true,
    previewApplyParity: true,
    v1Compatible: true,
    v2NotPublic: true
  }, null, 2));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
