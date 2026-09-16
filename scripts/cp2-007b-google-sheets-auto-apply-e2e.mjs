import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cp2-007b-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cp2-007b-password';
process.env.APP_MASTER_KEY = 'cp2-007b-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const pollingSource = await fs.readFile(path.join(process.cwd(), 'src', 'google-sheets-polling.ts'), 'utf8');
assert.match(pollingSource, /applyGoogleSheetsCloudMedia/);
assert.match(pollingSource, /beginMaintenance/);
assert.doesNotMatch(pollingSource, /publishPost|publishTarget|publisher\.js|markReady|READY.*UPDATE/);
const pollingUi = await fs.readFile(path.join(process.cwd(), 'public', 'google-sheets-v1.js'), 'utf8');
assert.match(pollingUi, /gs-auto-apply/);
assert.match(pollingUi, /autoApplyEnabled/);

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  type: 'service_account',
  client_email: 'auto-apply@test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.googleapis.com/token'
};
let valuesCalls = 0;
let sheetValues = [];
const header = [
  'schema_version','external_id','action','project','template_key','internal_title','body',
  'publication_kind','content_format','schedule_mode','scheduled_at','timezone','targets',
  'telegram_body','vk_body','max_body','instagram_body','media','tags','source_note','source_revision'
];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({ access_token: 'auto-token', expires_in: 3600 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  assert.match(String(init.headers?.authorization ?? init.headers?.Authorization ?? ''), /^Bearer auto-token$/);
  if (url.includes('?fields=properties.title,sheets.properties')) {
    return new Response(JSON.stringify({ properties: { title: 'Auto Apply Sheet' }, sheets: [{ properties: { sheetId: 0, title: 'Posts' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
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
  const { googleSheetsPollingTick } = await import('../dist/google-sheets-polling.js');
  migrate();
  let project = db.prepare('SELECT id,slug FROM projects ORDER BY created_at LIMIT 1').get();
  if (!project) {
    project = { id: id('prj'), slug: 'main' };
    db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)').run(project.id, 'Main', project.slug, nowIso());
  }
  const row = (title, body, revision) => [
    '3','auto-001','UPSERT',project.slug,'',title,body,'FEED','IMAGE','MANUAL','','UTC','[]',
    '','','','','','','',revision
  ];
  sheetValues = [header, row('Auto v1', 'Body v1', 'rev-1')];

  const app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const request = (method, url, payload) => app.inject({
    method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload })
  });
  const create = await request('POST', '/api/google-sheets/connectors', {
    name: 'Auto Apply Sheet', spreadsheetId: 'spreadsheet_auto_apply_12345', sheetName: 'Posts', writeBack: false, credentials: serviceAccount
  });
  assert.equal(create.statusCode, 201, create.body);
  const connector = create.json().connector;
  assert.equal(connector.config.pollingEnabled, false);
  assert.equal(connector.config.autoApplyEnabled, false, 'safe default must be notify-only');

  const enabled = await request('PUT', `/api/google-sheets/connectors/${connector.id}/polling`, {
    enabled: true, intervalMinutes: 5, autoApplyEnabled: true
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().connector.config.pollingEnabled, true);
  assert.equal(enabled.json().connector.config.autoApplyEnabled, true);

  const startedAt = new Date(Date.now() + 1000);
  const first = await googleSheetsPollingTick(startedAt);
  assert.equal(first.due, 1);
  assert.equal(first.previews, 1);
  assert.equal(first.autoAppliedRuns, 1);
  assert.equal(first.errors, 0);
  assert.equal(valuesCalls, 2, 'safe auto-apply must re-read Sheet and verify the preview snapshot');
  let post = db.prepare("SELECT id,title,body,status,editorial_stage,content_version,imported_content_version,ready_revision_id FROM posts WHERE source_type='google_sheets'").get();
  assert.ok(post?.id);
  assert.equal(post.title, 'Auto v1');
  assert.equal(post.status, 'DRAFT');
  assert.equal(post.editorial_stage, 'DRAFT');
  assert.equal(post.content_version, 1);
  assert.equal(post.imported_content_version, 1);
  assert.equal(post.ready_revision_id, null);

  const listed1 = await request('GET', '/api/google-sheets/connectors');
  const poll1 = listed1.json().connectors[0].polling;
  assert.equal(poll1.lastResult, 'success');
  assert.equal(poll1.lastAutoApply.ok, true);
  assert.equal(poll1.lastAutoApply.created, 1);
  assert.equal(poll1.lastAutoApply.updated, 0);

  db.prepare("UPDATE posts SET status='READY',editorial_stage='APPROVED',ready_revision_id=NULL WHERE id=?").run(post.id);
  sheetValues = [header, row('Auto v2', 'Body v2', 'rev-2')];
  const second = await googleSheetsPollingTick(new Date(startedAt.getTime() + 6 * 60_000));
  assert.equal(second.autoAppliedRuns, 1);
  post = db.prepare("SELECT id,title,body,status,editorial_stage,content_version,imported_content_version,ready_revision_id FROM posts WHERE id=?").get(post.id);
  assert.equal(post.title, 'Auto v2');
  assert.equal(post.body, 'Body v2');
  assert.equal(post.status, 'DRAFT', 'updated READY content must be returned to DRAFT');
  assert.equal(post.editorial_stage, 'DRAFT');
  assert.equal(post.ready_revision_id, null);
  assert.equal(post.content_version, 2);
  assert.equal(post.imported_content_version, 2);
  db.prepare("UPDATE posts SET title='Local operator edit',content_version=content_version+1,updated_at=? WHERE id=?").run(nowIso(), post.id);
  sheetValues = [header, row('Auto v3', 'Body v3', 'rev-3')];
  const beforeConflictCalls = valuesCalls;
  const conflict = await googleSheetsPollingTick(new Date(startedAt.getTime() + 12 * 60_000));
  assert.equal(conflict.due, 1);
  assert.equal(conflict.previews, 1);
  assert.equal(conflict.warnings, 1);
  assert.equal(conflict.autoAppliedRuns, 0);
  assert.equal(valuesCalls, beforeConflictCalls + 1, 'CONFLICT must stop before Apply re-read');
  post = db.prepare("SELECT title,body,status,content_version,imported_content_version FROM posts WHERE id=?").get(post.id);
  assert.equal(post.title, 'Local operator edit');
  assert.equal(post.body, 'Body v2');
  assert.equal(post.status, 'DRAFT');
  assert.equal(post.content_version, 3);
  assert.equal(post.imported_content_version, 2);

  const listed2 = await request('GET', '/api/google-sheets/connectors');
  const poll2 = listed2.json().connectors[0].polling;
  assert.equal(poll2.lastResult, 'success');
  assert.equal(poll2.lastSummary.conflicts, 1);
  assert.equal(poll2.lastAutoApply.attempted, false);

  const publishEvents = db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE event_type LIKE '%publish%' OR event_type LIKE '%queue_slot_fired%'").get().count;
  assert.equal(publishEvents, 0, 'ingestion automation must never invoke publication');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE status='PUBLISHED'").get().count, 0);
  const legacyUpdate = await request('PUT', `/api/google-sheets/connectors/${connector.id}/polling`, {
    enabled: true, intervalMinutes: 15
  });
  assert.equal(legacyUpdate.statusCode, 200, legacyUpdate.body);
  assert.equal(legacyUpdate.json().connector.config.autoApplyEnabled, true, 'older polling clients must not silently disable auto-apply');

  const disabledAutoApply = await request('PUT', `/api/google-sheets/connectors/${connector.id}/polling`, {
    enabled: true, intervalMinutes: 15, autoApplyEnabled: false
  });
  assert.equal(disabledAutoApply.statusCode, 200, disabledAutoApply.body);
  assert.equal(disabledAutoApply.json().connector.config.autoApplyEnabled, false);

  const appliedEvents = db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE event_type='google_sheets.applied' OR event_type='google_sheets.cloud_media_applied'").get().count;
  assert.equal(appliedEvents, 2);
  const pollEvents = db.prepare("SELECT event_type,data_json FROM publication_events WHERE event_type LIKE 'google_sheets.poll_preview_%' ORDER BY created_at").all();
  assert.equal(pollEvents.length, 3);
  assert.equal(JSON.parse(pollEvents[0].data_json).autoApply.ok, true);
  assert.equal(JSON.parse(pollEvents[1].data_json).autoApply.ok, true);
  assert.equal(JSON.parse(pollEvents[2].data_json).autoApply.attempted, false);

  await app.close();
  console.log('CP2-007B Google Sheets safe Auto Apply: PASS');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}

