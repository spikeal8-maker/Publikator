import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cp2-007c-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cp2-007c-password';
process.env.APP_MASTER_KEY = 'cp2-007c-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const pollingSource = await fs.readFile(path.join(process.cwd(), 'src', 'google-sheets-polling.ts'), 'utf8');
const readySource = await fs.readFile(path.join(process.cwd(), 'src', 'google-sheets-auto-ready.ts'), 'utf8');
assert.match(pollingSource, /autoReadyGoogleSheetsPost/);
assert.match(readySource, /preflightRevision/);
assert.match(readySource, /snapshotContentRevision/);
assert.match(readySource, /markReadyRevision/);
assert.doesNotMatch(`${pollingSource}\n${readySource}`, /publishPost|publishTarget|publishNow/);
const pollingUi = await fs.readFile(path.join(process.cwd(), 'public', 'google-sheets-v1.js'), 'utf8');
assert.match(pollingUi, /gs-auto-ready/);
assert.match(pollingUi, /autoReadyEnabled/);
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  type: 'service_account',
  client_email: 'auto-ready@test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.googleapis.com/token'
};

const header = [
  'schema_version','external_id','action','project','template_key','internal_title','body',
  'publication_kind','content_format','schedule_mode','scheduled_at','timezone','targets',
  'telegram_body','vk_body','max_body','instagram_body','media','tags','source_note','source_revision'
];
let valuesCalls = 0;
let sheetValues = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({ access_token: 'auto-ready-token', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  assert.match(String(init.headers?.authorization ?? init.headers?.Authorization ?? ''), /^Bearer auto-ready-token$/);
  if (url.includes('?fields=properties.title,sheets.properties')) {
    return new Response(JSON.stringify({ properties: { title: 'Auto Ready Sheet' }, sheets: [{ properties: { sheetId: 0, title: 'Posts' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/values/')) {
    valuesCalls += 1;
    return new Response(JSON.stringify({ range: "'Posts'!A1:U10001", majorDimension: 'ROWS', values: sheetValues }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`Unexpected Google request: ${url}`);
};

try {
  const { db, id, migrate, nowIso } = await import('../dist/db.js');
  const { encryptJson } = await import('../dist/crypto.js');
  const { buildApp } = await import('../dist/app.js');
  const { googleSheetsPollingTick } = await import('../dist/google-sheets-polling.js');
  migrate();

  let project = db.prepare('SELECT id,slug FROM projects ORDER BY created_at LIMIT 1').get();
  if (!project) {
    project = { id: id('prj'), slug: 'main' };
    db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)').run(project.id, 'Main', project.slug, nowIso());
  }
  const accountId = id('acc');
  const accountNow = nowIso();
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`)
    .run(accountId, 'telegram', 'Trusted Telegram', encryptJson({ botToken: 'mock-token', chatId: '@mock' }), accountNow, accountNow);

  const row = (title, body, revision) => [
    '3','trusted-001','UPSERT',project.slug,'',title,body,'FEED','IMAGE','MANUAL','','UTC',
    JSON.stringify([{ platform: 'telegram', name: 'Trusted Telegram' }]),
    '','','','','','','',revision
  ];
  sheetValues = [header, row('Trusted v1', 'Body v1', 'rev-1')];

  const app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const request = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  const create = await request('POST', '/api/google-sheets/connectors', {
    name: 'Trusted source', spreadsheetId: 'spreadsheet_auto_ready_12345', sheetName: 'Posts', writeBack: false,
    pollingEnabled: true, pollIntervalMinutes: 5, autoApplyEnabled: true, autoReadyEnabled: true,
    credentials: serviceAccount
  });
  assert.equal(create.statusCode, 201, create.body);
  const connector = create.json().connector;
  assert.equal(connector.config.autoApplyEnabled, true);
  assert.equal(connector.config.autoReadyEnabled, true);

  const forbidden = await request('PUT', `/api/google-sheets/connectors/${connector.id}/polling`, {
    enabled: true, intervalMinutes: 5, autoApplyEnabled: false, autoReadyEnabled: true
  });
  assert.equal(forbidden.statusCode, 400, forbidden.body);

  const startedAt = new Date(Date.now() + 1000);
  const first = await googleSheetsPollingTick(startedAt);
  assert.equal(first.autoAppliedRuns, 1);
  assert.equal(first.autoReadyPosts, 0);
  assert.equal(first.warnings, 1);
  assert.equal(valuesCalls, 2);
  let post = db.prepare(`SELECT id,title,body,status,editorial_stage,content_version,imported_content_version,ready_revision_id
    FROM posts WHERE source_type='google_sheets'`).get();
  assert.ok(post?.id);
  assert.equal(post.status, 'DRAFT');
  assert.equal(post.editorial_stage, 'DRAFT');
  assert.equal(post.ready_revision_id, null);
  assert.equal(post.content_version, 1);
  assert.equal(post.imported_content_version, 1);
  const blockedCount = db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE post_id=? AND event_type='google_sheets.auto_ready_blocked'").get(post.id).count;
  assert.equal(blockedCount, 1, 'missing media must block Auto Ready without undoing Auto Apply');

  const mediaId = id('med');
  db.prepare(`INSERT INTO media
    (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mediaId, post.id, 'trusted.jpg', `${post.id}/trusted.jpg`, 'image/jpeg', 1024, 1200, 1200, 'a'.repeat(64), nowIso(), 0);

  sheetValues = [header, row('Trusted v2', 'Body v2', 'rev-2')];
  const second = await googleSheetsPollingTick(new Date(startedAt.getTime() + 6 * 60_000));
  assert.equal(second.autoAppliedRuns, 1);
  assert.equal(second.autoReadyPosts, 1);
  assert.equal(valuesCalls, 4);
  post = db.prepare(`SELECT id,title,body,status,editorial_stage,content_version,imported_content_version,ready_revision_id
    FROM posts WHERE id=?`).get(post.id);
  assert.equal(post.title, 'Trusted v2');
  assert.equal(post.body, 'Body v2');
  assert.equal(post.status, 'READY');
  assert.equal(post.editorial_stage, 'APPROVED');
  assert.ok(post.ready_revision_id);
  assert.equal(post.content_version, 2);
  assert.equal(post.imported_content_version, 2);
  const revision = db.prepare('SELECT id,content_version,actor_source FROM content_revisions WHERE id=?').get(post.ready_revision_id);
  assert.equal(revision.content_version, 2);
  assert.equal(revision.actor_source, 'google_sheets');

  const readyCount = db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE post_id=? AND event_type='google_sheets.auto_ready_succeeded'").get(post.id).count;
  assert.equal(readyCount, 1);
  const publishCount = db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE event_type LIKE '%publish%' OR event_type LIKE '%queue_slot_fired%'").get().count;
  assert.equal(publishCount, 0, 'Auto Ready must not invoke publisher or publication scheduler');

  const listed = await request('GET', '/api/google-sheets/connectors');
  const polling = listed.json().connectors[0].polling;
  assert.equal(polling.lastAutoReady.ready, 1);
  assert.equal(polling.lastAutoReady.blocked, 0);
  const disableApply = await request('PUT', `/api/google-sheets/connectors/${connector.id}/polling`, {
    enabled: true, intervalMinutes: 15, autoApplyEnabled: false
  });
  assert.equal(disableApply.statusCode, 200, disableApply.body);
  assert.equal(disableApply.json().connector.config.autoApplyEnabled, false);
  assert.equal(disableApply.json().connector.config.autoReadyEnabled, false, 'disabling Auto Apply must also disable Auto Ready');

  await app.close();
  console.log('CP2-007C Google Sheets trusted-source Auto Ready: PASS');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
