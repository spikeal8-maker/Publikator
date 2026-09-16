import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cp2-008a-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cp2-008a-password';
process.env.APP_MASTER_KEY = 'cp2-008a-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = {
  type: 'service_account',
  client_email: 'publication-writeback@test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.googleapis.com/token'
};
let externalIdReads = 0;
let batchWrites = [];
let failBatch = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({ access_token: 'writeback-token', expires_in: 3600 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  assert.match(String(init.headers?.authorization ?? init.headers?.Authorization ?? ''), /^Bearer writeback-token$/);
  if (url.includes('/values/') && url.includes('B2%3AB10001')) {
    externalIdReads += 1;
    return new Response(JSON.stringify({ range: "'Posts'!B2:B10001", majorDimension: 'ROWS', values: [['sheet-post-001']] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  if (url.endsWith('/values:batchUpdate')) {
    const body = JSON.parse(String(init.body ?? '{}'));
    batchWrites.push(body);
    return new Response(JSON.stringify(failBatch ? { error: { message: 'temporary write failure' } } : { totalUpdatedRows: body.data?.length ?? 0 }), {
      status: failBatch ? 503 : 200, headers: { 'content-type': 'application/json' }
    });
  }
  throw new Error(`Unexpected Google request: ${url}`);
};
try {
  const { db, id, migrate, nowIso } = await import('../dist/db.js');
  const { encryptJson } = await import('../dist/crypto.js');
  const { createIngestionConnector } = await import('../dist/integration-security.js');
  const { googleSheetsPublicationWriteBackTick } = await import('../dist/google-sheets-publication-writeback.js');
  migrate();

  let project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
  if (!project) {
    project = { id: id('prj') };
    db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)')
      .run(project.id, 'Main', 'main', nowIso());
  }
  const connector = createIngestionConnector({
    type: 'google_sheets', name: 'Publication results',
    config: { spreadsheetId: 'spreadsheet_writeback_12345', sheetName: 'Posts', writeBack: true },
    credentials
  });
  const accountId = id('acc');
  const postId = id('post');
  const targetId = id('target');
  const now = '2026-09-16T18:00:00.000Z';
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`)
    .run(accountId, 'telegram', 'Main Telegram', encryptJson({ botToken: 'mock', chatId: '@mock' }), now, now);
  db.prepare(`INSERT INTO posts
    (id,project_id,title,body,status,editorial_stage,schedule_mode,content_version,source_type,source_ref,
     source_revision,source_payload_hash,imported_at,imported_content_version,created_at,updated_at)
    VALUES (?,?,?,?, 'PUBLISHED','APPROVED','MANUAL',1,'google_sheets',?,?,?,?,1,?,?)`)
    .run(postId, project.id, 'Published from Sheet', 'Body', JSON.stringify([`gs:${connector.id}`, 'sheet-post-001']),
      'rev-1', 'payload-1', now, now, now);
  db.prepare(`INSERT INTO post_targets
    (id,post_id,account_id,enabled,state,attempts,external_id,external_url,last_error,published_at,updated_at)
    VALUES (?,?,?,?, 'PUBLISHED',1,?,?,NULL,?,?)`)
    .run(targetId, postId, accountId, 1, 'telegram-123', 'https://t.me/example/123', now, now);

  const first = await googleSheetsPublicationWriteBackTick();
  assert.deepEqual(first, { skipped: false, pending: 1, written: 1, failed: 0 });
  assert.equal(externalIdReads, 1);
  assert.equal(batchWrites.length, 1);
  const firstBody = batchWrites[0];
  assert.equal(firstBody.valueInputOption, 'RAW');
  assert.equal(firstBody.data[0].range, "'Posts'!Z1:AD1");
  assert.deepEqual(firstBody.data[0].values[0], ['publication_status','editorial_stage','published_at','external_urls','publication_error']);
  assert.equal(firstBody.data[1].range, "'Posts'!Z2:AD2");
  assert.equal(firstBody.data[1].values[0][0], 'PUBLISHED');
  assert.equal(firstBody.data[1].values[0][1], 'APPROVED');
  assert.equal(firstBody.data[1].values[0][2], now);
  assert.match(firstBody.data[1].values[0][3], /https:\/\/t\.me\/example\/123/);
  assert.equal(firstBody.data[1].values[0][4], '');

  const second = await googleSheetsPublicationWriteBackTick();
  assert.deepEqual(second, { skipped: false, pending: 0, written: 0, failed: 0 });
  assert.equal(externalIdReads, 1, 'unchanged publication result must not re-read or rewrite Google Sheet');
  assert.equal(batchWrites.length, 1);

  db.prepare("UPDATE posts SET status='FAILED',updated_at=? WHERE id=?").run(nowIso(), postId);
  db.prepare("UPDATE post_targets SET state='FAILED',published_at=NULL,external_id=NULL,external_url=NULL,last_error=?,updated_at=? WHERE id=?")
    .run('=HYPERLINK("https://evil.example","click")', nowIso(), targetId);
  const failedStatus = await googleSheetsPublicationWriteBackTick();
  assert.deepEqual(failedStatus, { skipped: false, pending: 1, written: 1, failed: 0 });
  assert.equal(batchWrites.length, 2);
  const failedValues = batchWrites[1].data[1].values[0];
  assert.equal(failedValues[0], 'FAILED');
  assert.equal(failedValues[2], '');
  assert.equal(failedValues[3], '');
  assert.equal(/^[=+@-]/.test(failedValues[4].trimStart()), false, 'publication errors must be spreadsheet-safe');

  db.prepare("UPDATE posts SET status='PARTIAL',updated_at=? WHERE id=?").run(nowIso(), postId);
  db.prepare("UPDATE post_targets SET state='RECOVERY_NEEDED',last_error=?,updated_at=? WHERE id=?")
    .run('result unknown', nowIso(), targetId);
  failBatch = true;
  const writeFailure = await googleSheetsPublicationWriteBackTick();
  assert.deepEqual(writeFailure, { skipped: false, pending: 1, written: 0, failed: 1 });
  const preserved = db.prepare('SELECT status FROM posts WHERE id=?').get(postId);
  assert.equal(preserved.status, 'PARTIAL', 'Google write-back failure must never change canonical publication status');
  const warning = db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE post_id=? AND event_type='google_sheets.publication_writeback_failed'").get(postId);
  assert.equal(warning.count, 1);
  failBatch = false;
  const { buildApp } = await import('../dist/app.js');
  const app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const manualRetry = await app.inject({ method: 'POST', url: `/api/google-sheets/connectors/${connector.id}/publication-writeback`, headers: { cookie }, payload: {} });
  assert.equal(manualRetry.statusCode, 200, manualRetry.body);
  assert.equal(manualRetry.json().written, 1);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(postId).status, 'PARTIAL');
  await app.close();

  const successEvents = db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE post_id=? AND event_type='google_sheets.publication_writeback_succeeded'").get(postId);
  assert.equal(successEvents.count, 3);
  const workerSource = await fs.readFile(path.join(process.cwd(), 'src', 'google-sheets-publication-writeback.ts'), 'utf8');
  assert.match(workerSource, /spreadsheetSafeText/);
  assert.doesNotMatch(workerSource, /publishPost|publishTarget|markReadyRevision/);
  const serverSource = await fs.readFile(path.join(process.cwd(), 'src', 'server.ts'), 'utf8');
  assert.match(serverSource, /googleSheetsPublicationWriteBackTick/);
  const uiSource = await fs.readFile(path.join(process.cwd(), 'public', 'google-sheets-v1.js'), 'utf8');
  assert.match(uiSource, /V:AD/);

  console.log('CP2-008A Google Sheets publication result write-back: PASS');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
