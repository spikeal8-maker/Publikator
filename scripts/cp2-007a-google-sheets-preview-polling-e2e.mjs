import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cp2-007a-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cp2-007a-password';
process.env.APP_MASTER_KEY = 'cp2-007a-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const pollingSource = await fs.readFile(path.join(process.cwd(), 'src', 'google-sheets-polling.ts'), 'utf8');
assert.doesNotMatch(pollingSource, /publishPost|publishTarget|publisher\.js/);
assert.match(pollingSource, /previewGoogleSheetsCloudMedia/);
const pollingUi = await fs.readFile(path.join(process.cwd(), 'public', 'google-sheets-v1.js'), 'utf8');
assert.match(pollingUi, /\/polling/);
assert.match(pollingUi, /gs-poll-save/);
assert.match(pollingUi, /\[5,15,30,60\]/);

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  type: 'service_account',
  client_email: 'polling@test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.googleapis.com/token'
};

let valuesCalls = 0;
let failValues = false;
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
    return new Response(JSON.stringify({ access_token: 'poll-token', expires_in: 3600 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  assert.match(String(init.headers?.authorization ?? init.headers?.Authorization ?? ''), /^Bearer poll-token$/);
  if (url.includes('?fields=properties.title,sheets.properties')) {
    return new Response(JSON.stringify({ properties: { title: 'Polling Sheet' }, sheets: [{ properties: { sheetId: 0, title: 'Posts' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  if (url.includes('/values/')) {
    valuesCalls += 1;
    if (failValues) return new Response(JSON.stringify({ error: { message: 'temporary sheet error' } }), { status: 503, headers: { 'content-type': 'application/json' } });
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
  const row = (revision = 'rev-1') => [
    '3','poll-001','UPSERT',project.slug,'','Polling post','Preview only body','FEED','IMAGE','MANUAL','','UTC','[]',
    '','','','','','','',revision
  ];
  sheetValues = [header, row()];

  const app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const request = (method, url, payload) => app.inject({
    method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload })
  });

  const create = await request('POST', '/api/google-sheets/connectors', {
    name: 'Polling Sheet', spreadsheetId: 'spreadsheet_polling_12345', sheetName: 'Posts', writeBack: false, credentials: serviceAccount
  });
  assert.equal(create.statusCode, 201, create.body);
  const connector = create.json().connector;
  assert.equal(connector.config.pollingEnabled, false);
  assert.equal(connector.config.pollIntervalMinutes, 15);

  const invalid = await request('PUT', `/api/google-sheets/connectors/${connector.id}/polling`, { enabled: true, intervalMinutes: 7 });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.match(invalid.json().error, /5, 15, 30 or 60/);

  const enabled = await request('PUT', `/api/google-sheets/connectors/${connector.id}/polling`, { enabled: true, intervalMinutes: 5 });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().connector.config.pollingEnabled, true);
  assert.equal(enabled.json().connector.config.pollIntervalMinutes, 5);
  assert.equal(enabled.json().polling.lastAttemptAt, null);

  const startedAt = new Date(Date.now() + 1000);
  const first = await googleSheetsPollingTick(startedAt);
  assert.equal(first.skipped, false);
  assert.equal(first.checked, 1);
  assert.equal(first.due, 1);
  assert.equal(first.previews, 1);
  assert.equal(first.errors, 0);
  assert.equal(valuesCalls, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 0, 'polling Preview must not create posts');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media').get().count, 0, 'polling Preview must not create media');

  const listed = await request('GET', '/api/google-sheets/connectors');
  assert.equal(listed.statusCode, 200, listed.body);
  const listedConnector = listed.json().connectors[0];
  assert.equal(listedConnector.polling.enabled, true);
  assert.equal(listedConnector.polling.intervalMinutes, 5);
  assert.equal(listedConnector.polling.lastResult, 'success');
  assert.equal(listedConnector.polling.lastSummary.newRows, 1);
  assert.equal(listedConnector.polling.lastCanApply, true);
  assert.match(listedConnector.polling.lastAttemptAt, /^\d{4}-/);
  assert.match(listedConnector.polling.nextDueAt, /^\d{4}-/);

  const early = await googleSheetsPollingTick(new Date(startedAt.getTime() + 4 * 60_000));
  assert.equal(early.due, 0);
  assert.equal(valuesCalls, 1, 'polling must respect configured interval');
  sheetValues = [header, row('rev-2')];
  const dueAgain = await googleSheetsPollingTick(new Date(startedAt.getTime() + 6 * 60_000));
  assert.equal(dueAgain.due, 1);
  assert.equal(dueAgain.previews, 1);
  assert.equal(valuesCalls, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 0);

  failValues = true;
  const failed = await googleSheetsPollingTick(new Date(startedAt.getTime() + 12 * 60_000));
  assert.equal(failed.due, 1);
  assert.equal(failed.errors, 1);
  assert.equal(valuesCalls, 3);
  const afterFailure = await request('GET', '/api/google-sheets/connectors');
  const failureState = afterFailure.json().connectors[0].polling;
  assert.equal(failureState.lastResult, 'failed');
  assert.match(failureState.lastError, /HTTP 503/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 0);

  const events = db.prepare("SELECT event_type,data_json FROM publication_events WHERE event_type LIKE 'google_sheets.poll_preview_%' ORDER BY created_at").all();
  assert.equal(events.length, 3);
  assert.equal(events.filter((item) => item.event_type === 'google_sheets.poll_preview_succeeded').length, 2);
  assert.equal(events.filter((item) => item.event_type === 'google_sheets.poll_preview_failed').length, 1);
  for (const item of events) assert.equal(JSON.parse(item.data_json).connectorId, connector.id);

  const disabled = await request('PUT', `/api/google-sheets/connectors/${connector.id}/polling`, { enabled: false, intervalMinutes: 5 });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().polling.enabled, false);
  const callsBeforeDisabledTick = valuesCalls;
  const disabledTick = await googleSheetsPollingTick(new Date(startedAt.getTime() + 30 * 60_000));
  assert.equal(disabledTick.checked, 0);
  assert.equal(valuesCalls, callsBeforeDisabledTick);

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE event_type='content_plan_v3_applied'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE event_type='google_sheets.applied'").get().count, 0);
  await app.close();
  console.log('CP2-007A Google Sheets Preview-only polling: PASS');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
