import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cp2-007d-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cp2-007d-password';
process.env.APP_MASTER_KEY = 'cp2-007d-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';
process.env.QUEUE_SLOT_GRACE_MINUTES = '60';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  type: 'service_account',
  client_email: 'full-auto@test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.googleapis.com/token'
};
const header = [
  'schema_version','external_id','action','project','template_key','internal_title','body',
  'publication_kind','content_format','schedule_mode','scheduled_at','timezone','targets',
  'telegram_body','vk_body','max_body','instagram_body','media','tags','source_note','source_revision'
];
const rootFolderId = 'root_full_auto_12345';
const imageBuffer = await sharp({
  create: { width: 1200, height: 630, channels: 3, background: '#335577' }
}).jpeg({ quality: 90 }).toBuffer();
const mediaCell = JSON.stringify([{ source: 'ASA Media', path: 'lesson-01.jpg' }]);
let sheetValues = [];
let sheetReads = 0;
let driveDownloads = 0;
const publishedPostIds = [];

const row = (project, id, mode, at = '') => [
  '3', id, 'UPSERT', project, '', `Title ${id}`, `Body ${id}`, 'FEED', 'IMAGE', mode, at,
  mode === 'AT' ? 'UTC' : '', JSON.stringify([{ platform: 'telegram', name: 'Auto Telegram' }]),
  '', '', '', '', mediaCell, '', '', 'rev-1'
];
function driveFile() {
  return {
    id: 'img-full-auto', name: 'lesson-01.jpg', mimeType: 'image/jpeg',
    size: String(imageBuffer.length), md5Checksum: 'full-auto-md5-v1',
    modifiedTime: '2026-09-07T08:00:00Z', parents: [rootFolderId],
    capabilities: { canDownload: true }
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({ access_token: 'google-test-token', expires_in: 3600 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  const parsed = new URL(url);
  const auth = String(init.headers?.authorization ?? init.headers?.Authorization ?? '');
  assert.equal(auth, 'Bearer google-test-token');
  if (parsed.hostname === 'sheets.googleapis.com') {
    if (url.includes('?fields=properties.title,sheets.properties')) {
      return new Response(JSON.stringify({ properties: { title: 'Full Auto Sheet' }, sheets: [{ properties: { sheetId: 0, title: 'Posts' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/values/')) {
      sheetReads += 1;
      return new Response(JSON.stringify({ range: "'Posts'!A1:U10001", majorDimension: 'ROWS', values: sheetValues }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  }
  if (parsed.hostname === 'www.googleapis.com' && parsed.pathname.startsWith('/drive/v3/files')) {
    if (parsed.pathname === `/drive/v3/files/${rootFolderId}`) {
      return new Response(JSON.stringify({ id: rootFolderId, name: 'ASA Media', mimeType: 'application/vnd.google-apps.folder', capabilities: { canDownload: true } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/drive/v3/files' && parsed.searchParams.has('q')) {
      return new Response(JSON.stringify({ files: [driveFile()] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/drive/v3/files/img-full-auto' && parsed.searchParams.get('alt') === 'media') {
      driveDownloads += 1;
      return new Response(imageBuffer, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(imageBuffer.length) }
      });
    }
    if (parsed.pathname === '/drive/v3/files/img-full-auto') {
      return new Response(JSON.stringify(driveFile()), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  }
  throw new Error(`Unexpected Google request: ${url}`);
};
try {
  const { db, id, migrate, nowIso } = await import('../dist/db.js');
  const { encryptJson } = await import('../dist/crypto.js');
  const { buildApp } = await import('../dist/app.js');
  const { googleSheetsPollingTick } = await import('../dist/google-sheets-polling.js');
  const { schedulerTick } = await import('../dist/scheduler.js');
  const { setPublisherForTests } = await import('../dist/platforms/index.js');
  migrate();

  let project = db.prepare('SELECT id,slug FROM projects ORDER BY created_at LIMIT 1').get();
  if (!project) {
    project = { id: id('prj'), slug: 'main' };
    db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)')
      .run(project.id, 'Main', project.slug, '2026-01-01T00:00:00.000Z');
  }
  const accountId = id('acc');
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`)
    .run(accountId, 'telegram', 'Auto Telegram', encryptJson({ botToken: 'mock-token', chatId: '@mock' }), nowIso(), nowIso());
  setPublisherForTests('telegram', {
    platform: 'telegram',
    validate(input) {
      assert.equal(input.media.length, 1);
      assert.equal(input.media[0].mime_type, 'image/jpeg');
    },
    async publish(input) {
      publishedPostIds.push(input.postId);
      return { externalId: `mock-${input.postId}`, externalUrl: `https://example.test/${input.postId}` };
    }
  });

  db.prepare(`INSERT INTO schedule_slots
    (id,project_id,weekday,time_hhmm,timezone,enabled,last_fired_on,created_at)
    VALUES (?,?,?,?,?,1,NULL,?)`)
    .run(id('slot'), project.id, 1, '10:00', 'UTC', '2026-01-01T00:00:00.000Z');

  sheetValues = [
    header,
    row(project.slug, 'full-auto-queue', 'QUEUE'),
    row(project.slug, 'full-auto-at', 'AT', '2026-09-07T10:00:00Z'),
    row(project.slug, 'full-auto-manual', 'MANUAL')
  ];
  const app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const request = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });

  const createDrive = await request('POST', '/api/google-drive/connectors', {
    name: 'ASA Media', rootFolder: rootFolderId, credentials: serviceAccount
  });
  assert.equal(createDrive.statusCode, 201, createDrive.body);

  const createSheet = await request('POST', '/api/google-sheets/connectors', {
    name: 'Full Auto Sheet', spreadsheetId: 'spreadsheet_full_auto_12345', sheetName: 'Posts',
    writeBack: false, pollingEnabled: true, pollIntervalMinutes: 5,
    autoApplyEnabled: true, autoReadyEnabled: true, credentials: serviceAccount
  });
  assert.equal(createSheet.statusCode, 201, createSheet.body);
  const sheetConnector = createSheet.json().connector;
  const pollAt = new Date('2026-09-07T09:55:00.000Z');
  const polled = await googleSheetsPollingTick(pollAt);
  assert.equal(polled.due, 1);
  assert.equal(polled.autoAppliedRuns, 1);
  assert.equal(polled.autoReadyPosts, 3);
  assert.equal(publishedPostIds.length, 0, 'ingestion/Auto Ready must not publish externally');
  assert.equal(sheetReads, 2, 'full-auto import must retain Preview + stale-snapshot re-read');
  assert.equal(driveDownloads, 3);

  const posts = db.prepare(`SELECT id,source_ref,schedule_mode,status,editorial_stage,ready_revision_id
    FROM posts WHERE source_type='google_sheets' ORDER BY source_ref`).all();
  assert.equal(posts.length, 3);
  for (const post of posts) {
    assert.equal(post.status, 'READY');
    assert.equal(post.editorial_stage, 'APPROVED');
    assert.ok(post.ready_revision_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media WHERE post_id=?').get(post.id).count, 1);
  }

  const byExternalId = new Map(posts.map((post) => [JSON.parse(post.source_ref)[1], post]));
  const queuePost = byExternalId.get('full-auto-queue');
  const atPost = byExternalId.get('full-auto-at');
  const manualPost = byExternalId.get('full-auto-manual');
  assert.ok(queuePost && atPost && manualPost);
  await schedulerTick(new Date('2026-09-07T10:05:00.000Z'));
  const after = db.prepare(`SELECT id,status,schedule_mode FROM posts
    WHERE source_type='google_sheets' ORDER BY source_ref`).all();
  const statusById = new Map(after.map((post) => [post.id, post.status]));
  assert.equal(statusById.get(queuePost.id), 'PUBLISHED');
  assert.equal(statusById.get(atPost.id), 'PUBLISHED');
  assert.equal(statusById.get(manualPost.id), 'READY', 'MANUAL content must never be auto-published by scheduler');
  assert.equal(publishedPostIds.filter((id) => id === queuePost.id).length, 1);
  assert.equal(publishedPostIds.filter((id) => id === atPost.id).length, 1);
  assert.equal(publishedPostIds.includes(manualPost.id), false);

  const queueEvents = db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE post_id=? AND event_type='queue_slot_fired'").get(queuePost.id).count;
  assert.equal(queueEvents, 1);
  const targetRows = db.prepare(`SELECT pt.post_id,pt.state,pt.external_id,pt.external_url
    FROM post_targets pt WHERE pt.post_id IN (?,?,?) ORDER BY pt.post_id`).all(queuePost.id, atPost.id, manualPost.id);
  assert.equal(targetRows.filter((row) => row.state === 'PUBLISHED').length, 2);
  assert.equal(targetRows.filter((row) => row.post_id === manualPost.id)[0].state, 'PENDING');
  const publishedBeforeSecondTick = publishedPostIds.length;
  await schedulerTick(new Date('2026-09-07T10:10:00.000Z'));
  assert.equal(publishedPostIds.length, publishedBeforeSecondTick, 'same queue slot / AT occurrence must not publish twice');

  for (const post of posts) {
    const media = db.prepare('SELECT relative_path FROM media WHERE post_id=?').get(post.id);
    assert.ok(media?.relative_path);
    const localFile = path.join(dataDir, 'media', media.relative_path);
    assert.equal((await fs.stat(localFile)).isFile(), true, 'publisher must use locally materialized canonical media');
  }

  const polling = (await request('GET', '/api/google-sheets/connectors')).json().connectors
    .find((item) => item.id === sheetConnector.id).polling;
  assert.equal(polling.lastAutoApply.ok, true);
  assert.equal(polling.lastAutoReady.ready, 3);

  await app.close();
  setPublisherForTests('telegram', null);
  console.log('CP2-007D Google Sheets -> READY -> scheduler -> publisher: PASS');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
