import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cp2-005-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cp2-005-acceptance-password';
process.env.APP_MASTER_KEY = 'cp2-005-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const serviceAccount = {
  type: 'service_account',
  client_email: 'publikator-test@test-project.iam.gserviceaccount.com',
  private_key: privateKeyPem,
  token_uri: 'https://oauth2.googleapis.com/token'
};

const header = [
  'schema_version', 'external_id', 'action', 'project', 'template_key', 'internal_title', 'body',
  'publication_kind', 'content_format', 'schedule_mode', 'scheduled_at', 'timezone', 'targets',
  'telegram_body', 'vk_body', 'max_body', 'instagram_body', 'media', 'tags', 'source_note', 'source_revision'
];
let sheetValues = [];
let writeBackFailure = false;
const writeBackBodies = [];
let metadataCalls = 0;
let valuesCalls = 0;
let tokenCalls = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') {
    tokenCalls += 1;
    assert.equal(init.method, 'POST');
    assert.match(String(init.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
    return new Response(JSON.stringify({ access_token: `token-${tokenCalls}`, expires_in: 3600, token_type: 'Bearer' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  assert.match(String(init.headers?.authorization ?? init.headers?.Authorization ?? ''), /^Bearer token-/);
  if (url.includes('?fields=properties.title,sheets.properties')) {
    metadataCalls += 1;
    return new Response(JSON.stringify({
      properties: { title: 'Publikator Test Sheet' },
      sheets: [{ properties: { sheetId: 0, title: 'Posts' } }, { properties: { sheetId: 1, title: 'Archive' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.endsWith('/values:batchUpdate')) {
    const body = JSON.parse(String(init.body));
    writeBackBodies.push(body);
    if (writeBackFailure) return new Response(JSON.stringify({ error: { message: 'write blocked' } }), { status: 403, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ totalUpdatedCells: body.data.length * 4 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/values/')) {
    valuesCalls += 1;
    return new Response(JSON.stringify({ range: "'Posts'!A1:U10001", majorDimension: 'ROWS', values: sheetValues }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  throw new Error(`Unexpected Google request: ${url}`);
};

try {
  const { db, id, migrate, nowIso } = await import('../dist/db.js');
  const { buildApp } = await import('../dist/app.js');
  migrate();
  let project = db.prepare('SELECT id,slug FROM projects ORDER BY created_at LIMIT 1').get();
  if (!project) {
    project = { id: id('prj'), slug: 'main' };
    db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)').run(project.id, 'Main', project.slug, nowIso());
  }

  const row = (externalId, title, body, revision) => [
    '3', externalId, 'UPSERT', project.slug, '', title, body, 'FEED', 'IMAGE', 'MANUAL', '', 'UTC', '[]',
    '', '', '', '', '', '', '', revision
  ];
  sheetValues = [header, row('sheet-001', 'From Google', 'Body v1', 'rev-1')];

  const app = await buildApp();
  await app.ready();
  const anonymous = await app.inject({ method: 'GET', url: '/api/google-sheets/connectors' });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const request = (method, url, payload) => app.inject({
    method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload })
  });

  const inspect = await request('POST', '/api/google-sheets/inspect', { spreadsheetId: 'spreadsheet_test_12345', credentials: serviceAccount });
  assert.equal(inspect.statusCode, 200, inspect.body);
  assert.deepEqual(inspect.json().sheets, ['Posts', 'Archive']);
  assert.equal(inspect.json().serviceAccountEmail, serviceAccount.client_email);

  const create = await request('POST', '/api/google-sheets/connectors', {
    name: 'Editorial Sheet', spreadsheetId: 'spreadsheet_test_12345', sheetName: 'Posts', writeBack: true, credentials: serviceAccount
  });
  assert.equal(create.statusCode, 201, create.body);
  const connector = create.json().connector;
  assert.equal(connector.type, 'google_sheets');
  assert.equal(connector.config.sheetName, 'Posts');
  assert.equal(connector.config.serviceAccountEmail, serviceAccount.client_email);
  const stored = db.prepare('SELECT config_json,credentials_encrypted FROM ingestion_connectors WHERE id=?').get(connector.id);
  assert.ok(stored.credentials_encrypted.startsWith('v1:'));
  assert.ok(!stored.credentials_encrypted.includes('BEGIN PRIVATE KEY'));
  assert.ok(!stored.config_json.includes('private_key'));

  const connectors = await request('GET', '/api/google-sheets/connectors');
  assert.equal(connectors.statusCode, 200, connectors.body);
  assert.equal(connectors.json().connectors.length, 1);
  assert.equal(JSON.stringify(connectors.json()).includes('private_key'), false);

  const preview1 = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(preview1.statusCode, 200, preview1.body);
  assert.equal(preview1.json().summary.newRows, 1);
  assert.equal(preview1.json().canApply, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 0, 'preview must not mutate posts');
  const staleSha = preview1.json().sourceSnapshotSha256;

  sheetValues = [header, row('sheet-001', 'From Google', 'Body changed before apply', 'rev-2')];
  const staleApply = await request('POST', `/api/google-sheets/connectors/${connector.id}/apply`, { confirm: 'IMPORT', previewSha: staleSha });
  assert.equal(staleApply.statusCode, 409, staleApply.body);
  assert.match(staleApply.json().error, /changed after preview/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 0);

  const preview2 = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(preview2.statusCode, 200, preview2.body);
  assert.equal(preview2.json().summary.newRows, 1);
  const apply1 = await request('POST', `/api/google-sheets/connectors/${connector.id}/apply`, { confirm: 'IMPORT', previewSha: preview2.json().sourceSnapshotSha256 });
  assert.equal(apply1.statusCode, 200, apply1.body);
  assert.equal(apply1.json().created, 1);
  assert.equal(apply1.json().writeBack.ok, true);
  let post = db.prepare("SELECT * FROM posts WHERE source_type='google_sheets'").get();
  assert.ok(post);
  assert.equal(post.status, 'DRAFT');
  assert.equal(post.editorial_stage, 'DRAFT');
  assert.equal(post.body, 'Body changed before apply');
  assert.deepEqual(JSON.parse(post.source_ref), [`gs:${connector.id}`, 'sheet-001']);
  assert.equal(post.source_revision, 'rev-2');
  assert.ok(writeBackBodies.at(-1).data.some((item) => item.range.includes('V1:Y1')));
  assert.ok(writeBackBodies.at(-1).data.some((item) => item.range.includes('V2:Y2')));

  const unchanged = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  assert.equal(unchanged.json().summary.unchangedRows, 1);

  sheetValues = [header, row('sheet-001', 'From Google', 'Body v3', 'rev-3')];
  const updatePreview = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(updatePreview.json().summary.updateRows, 1);
  const updateApply = await request('POST', `/api/google-sheets/connectors/${connector.id}/apply`, { confirm: 'IMPORT', previewSha: updatePreview.json().sourceSnapshotSha256 });
  assert.equal(updateApply.statusCode, 200, updateApply.body);
  assert.equal(updateApply.json().updated, 1);
  post = db.prepare('SELECT * FROM posts WHERE id=?').get(post.id);
  assert.equal(post.body, 'Body v3');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 1, 'update must not duplicate');

  writeBackFailure = true;
  sheetValues = [
    header,
    row('sheet-001', 'From Google', 'Body v3', 'rev-3'),
    row('sheet-002', 'Second Google row', 'Second body', 'rev-1')
  ];
  const secondPreview = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(secondPreview.json().summary.newRows, 1);
  const secondApply = await request('POST', `/api/google-sheets/connectors/${connector.id}/apply`, { confirm: 'IMPORT', previewSha: secondPreview.json().sourceSnapshotSha256 });
  assert.equal(secondApply.statusCode, 200, secondApply.body);
  assert.equal(secondApply.json().created, 1);
  assert.equal(secondApply.json().writeBack.attempted, true);
  assert.equal(secondApply.json().writeBack.ok, false, 'write-back failure must not roll back canonical import');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 2);
  writeBackFailure = false;

  db.prepare('UPDATE posts SET body=?,content_version=content_version+1 WHERE id=?').run('Manual local edit', post.id);
  sheetValues = [header, row('sheet-001', 'From Google', 'Body from Sheet after local edit', 'rev-4')];
  const conflict = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(conflict.statusCode, 200, conflict.body);
  assert.equal(conflict.json().summary.conflicts, 1);
  assert.equal(conflict.json().canApply, false);

  sheetValues = [header];
  const deletedRowPreview = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(deletedRowPreview.statusCode, 400, deletedRowPreview.body);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 2, 'removing a Sheet row must never delete a post');

  const badAction = [header, [...row('sheet-003', 'Archive?', 'Body', 'rev-1').slice(0, 2), 'ARCHIVE', ...row('sheet-003', 'Archive?', 'Body', 'rev-1').slice(3)]];
  sheetValues = badAction;
  const archiveAttempt = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(archiveAttempt.statusCode, 400, archiveAttempt.body);
  assert.match(archiveAttempt.json().error, /UPSERT only/i);

  assert.ok(metadataCalls >= 2);
  assert.ok(valuesCalls >= 6);

  const ui = await fs.readFile(path.join(process.cwd(), 'public', 'google-sheets-v1.js'), 'utf8');
  const index = await fs.readFile(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  assert.match(ui, /Preview sync/);
  assert.match(ui, /Service Account JSON/);
  assert.match(ui, /row deletion never deletes|Удаление строк/i);
  assert.match(index, /google-sheets-v1\.js/);

  await app.close();
  console.log('CP2-005 Google Sheets connector: PASS');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
