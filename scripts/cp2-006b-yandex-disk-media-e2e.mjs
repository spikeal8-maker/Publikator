import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cp2-006b-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cp2-006b-acceptance-password';
process.env.APP_MASTER_KEY = 'cp2-006b-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  type: 'service_account',
  client_email: 'publikator-sheet@test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.googleapis.com/token'
};
const yandexToken = 'y0_AgAAAAAA-test-token-for-publikator-006b-1234567890';
const header = [
  'schema_version','external_id','action','project','template_key','internal_title','body',
  'publication_kind','content_format','schedule_mode','scheduled_at','timezone','targets',
  'telegram_body','vk_body','max_body','instagram_body','media','tags','source_note','source_revision'
];
const row = (project, externalId, title, revision, media) => [
  '3',externalId,'UPSERT',project,'',title,`${title} body`,'FEED','IMAGE','MANUAL','','UTC','[]',
  '','','','',media,'','',revision
];

const rootPath = 'disk:/Publikator/ASA';
let imageBuffer = await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#336699' } }).jpeg({ quality: 90 }).toBuffer();
let imageRevision = 'ydisk-md5-v1';
let imageModified = '2026-09-15T12:00:00Z';
let sheetValues = [];
let downloadCalls = 0;
let metadataCalls = 0;
function oauthScope(init) {
  const body = new URLSearchParams(String(init.body || ''));
  const assertion = body.get('assertion') || '';
  const parts = assertion.split('.');
  if (parts.length !== 3) return '';
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).scope || '';
}

function yandexFile() {
  return {
    name: 'lesson-01.jpg',
    path: `${rootPath}/lesson-01.jpg`,
    type: 'file',
    mime_type: 'image/jpeg',
    size: imageBuffer.length,
    md5: imageRevision,
    modified: imageModified,
    resource_id: 'disk:/lesson-01.jpg'
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') {
    assert.match(oauthScope(init), /spreadsheets/);
    return new Response(JSON.stringify({ access_token: 'sheet-token', expires_in: 3600 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  const parsed = new URL(url);
  if (parsed.hostname === 'sheets.googleapis.com') {
    assert.match(String(init.headers?.authorization ?? init.headers?.Authorization ?? ''), /^Bearer sheet-token$/);
    if (url.includes('?fields=properties.title,sheets.properties')) {
      return new Response(JSON.stringify({ properties: { title: 'Yandex Media Sheet' }, sheets: [{ properties: { sheetId: 0, title: 'Posts' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/values/')) {
      return new Response(JSON.stringify({ range: "'Posts'!A1:U10001", majorDimension: 'ROWS', values: sheetValues }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  }
  if (parsed.hostname === 'cloud-api.yandex.net') {
    assert.equal(String(init.headers?.authorization ?? init.headers?.Authorization ?? ''), `OAuth ${yandexToken}`);
    if (parsed.pathname === '/v1/disk/resources') {
      metadataCalls += 1;
      const diskPath = parsed.searchParams.get('path');
      if (diskPath === rootPath) {
        return new Response(JSON.stringify({ name: 'ASA Yandex Media', path: rootPath, type: 'dir' }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }
      if (diskPath === `${rootPath}/lesson-01.jpg`) {
        return new Response(JSON.stringify(yandexFile()), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (diskPath === `${rootPath}/missing.jpg`) {
        return new Response(JSON.stringify({ error: 'DiskNotFoundError' }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected Yandex resource path: ${diskPath}`);
    }
    if (parsed.pathname === '/v1/disk/resources/download') {
      const diskPath = parsed.searchParams.get('path');
      assert.equal(diskPath, `${rootPath}/lesson-01.jpg`);
      return new Response(JSON.stringify({ href: 'https://downloader.disk.yandex.ru/test/lesson-01.jpg', method: 'GET' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  }
  if (parsed.hostname === 'downloader.disk.yandex.ru') {
    downloadCalls += 1;
    assert.equal(parsed.pathname, '/test/lesson-01.jpg');
    return new Response(imageBuffer, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(imageBuffer.length) } });
  }
  throw new Error(`Unexpected request: ${url}`);
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
  const app = await buildApp();
  await app.ready();
  const anonymous = await app.inject({ method: 'GET', url: '/api/yandex-disk/connectors' });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const request = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });

  const inspect = await request('POST', '/api/yandex-disk/inspect', {
    credentials: { oauthToken: yandexToken }, rootPath: '/Publikator/ASA'
  });
  assert.equal(inspect.statusCode, 200, inspect.body);
  assert.equal(inspect.json().rootFolderName, 'ASA Yandex Media');
  assert.equal(inspect.json().rootPath, rootPath);

  const createYandex = await request('POST', '/api/yandex-disk/connectors', {
    name: 'Yandex Media', rootPath: '/Publikator/ASA', credentials: { oauthToken: yandexToken }
  });
  assert.equal(createYandex.statusCode, 201, createYandex.body);
  const yandexConnector = createYandex.json().connector;
  assert.equal(yandexConnector.type, 'yandex_disk');
  const stored = db.prepare('SELECT config_json,credentials_encrypted FROM ingestion_connectors WHERE id=?').get(yandexConnector.id);
  assert.ok(stored.credentials_encrypted.startsWith('v1:'));
  assert.equal(stored.config_json.includes(yandexToken), false);
  assert.equal(stored.credentials_encrypted.includes(yandexToken), false);
  const listed = await request('GET', '/api/yandex-disk/connectors');
  assert.equal(JSON.stringify(listed.json()).includes(yandexToken), false);
  const tested = await request('POST', `/api/yandex-disk/connectors/${yandexConnector.id}/test`, {});
  assert.equal(tested.statusCode, 200, tested.body);

  const createSheet = await request('POST', '/api/google-sheets/connectors', {
    name: 'Editorial Sheet', spreadsheetId: 'spreadsheet_test_006b', sheetName: 'Posts', writeBack: false, credentials: serviceAccount
  });
  assert.equal(createSheet.statusCode, 201, createSheet.body);
  const sheetConnector = createSheet.json().connector;
  const mediaCell = JSON.stringify([{ source: 'Yandex Media', path: 'lesson-01.jpg' }]);
  sheetValues = [header, row(project.slug, 'ydisk-001', 'Yandex image', 'rev-1', mediaCell)];
  const preview1 = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(preview1.statusCode, 200, preview1.body);
  assert.equal(preview1.json().summary.newRows, 1);
  assert.equal(preview1.json().managedMediaRows, 1);
  assert.equal(preview1.json().rows[0].mediaPreview.items[0].provider, 'yandex_disk');
  assert.match(preview1.json().mediaSnapshotSha256, /^[a-f0-9]{64}$/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media').get().count, 0);

  const withoutMediaSha = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/apply`, {
    confirm: 'IMPORT', previewSha: preview1.json().sourceSnapshotSha256
  });
  assert.equal(withoutMediaSha.statusCode, 409, withoutMediaSha.body);
  assert.match(withoutMediaSha.json().error, /cloud media.*preview/i);

  const apply1 = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/apply`, {
    confirm: 'IMPORT', previewSha: preview1.json().sourceSnapshotSha256, mediaPreviewSha: preview1.json().mediaSnapshotSha256
  });
  assert.equal(apply1.statusCode, 200, apply1.body);
  assert.equal(apply1.json().created, 1);
  assert.equal(apply1.json().media.syncedRows, 1);
  let post = db.prepare("SELECT * FROM posts WHERE source_type='google_sheets' AND source_ref=?")
    .get(JSON.stringify([`gs:${sheetConnector.id}`, 'ydisk-001']));
  assert.ok(post);
  assert.equal(post.status, 'DRAFT');
  assert.equal(post.content_version, post.imported_content_version);
  let mediaRows = db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order').all(post.id);
  assert.equal(mediaRows.length, 1);
  assert.equal(mediaRows[0].mime_type, 'image/jpeg');
  assert.equal(mediaRows[0].original_name, 'lesson-01.jpg');
  assert.equal((await fs.stat(path.join(dataDir, 'media', mediaRows[0].relative_path))).isFile(), true);
  assert.ok(downloadCalls >= 1);

  const unchanged = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  assert.equal(unchanged.json().summary.unchangedRows, 1);
  const downloadsBeforeRepeat = downloadCalls;
  const repeat = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/apply`, {
    confirm: 'IMPORT', previewSha: unchanged.json().sourceSnapshotSha256, mediaPreviewSha: unchanged.json().mediaSnapshotSha256
  });
  assert.equal(repeat.statusCode, 200, repeat.body);
  assert.equal(repeat.json().unchanged, 1);
  assert.equal(downloadCalls, downloadsBeforeRepeat);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media WHERE post_id=?').get(post.id).count, 1);
  imageBuffer = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: '#884422' } }).jpeg({ quality: 88 }).toBuffer();
  imageRevision = 'ydisk-md5-v2';
  imageModified = '2026-09-15T13:00:00Z';
  sheetValues = [header, row(project.slug, 'ydisk-001', 'Yandex image', 'rev-2', mediaCell)];
  const replacePreview = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(replacePreview.statusCode, 200, replacePreview.body);
  assert.equal(replacePreview.json().summary.updateRows, 1);
  const replaceApply = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/apply`, {
    confirm: 'IMPORT', previewSha: replacePreview.json().sourceSnapshotSha256, mediaPreviewSha: replacePreview.json().mediaSnapshotSha256
  });
  assert.equal(replaceApply.statusCode, 200, replaceApply.body);
  mediaRows = db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order').all(post.id);
  assert.equal(mediaRows.length, 1, 'remote update must replace media instead of appending');
  assert.equal(mediaRows[0].width, 1080);
  assert.equal(mediaRows[0].height, 1080);
  const badRelativePath = ['..', 'secret.jpg'].join('/');
  sheetValues = [header, row(project.slug, 'ydisk-traversal', 'Traversal', 'rev-1', JSON.stringify([{ source: 'Yandex Media', path: badRelativePath }]))];
  const traversal = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(traversal.statusCode, 200, traversal.body);
  assert.equal(traversal.json().summary.errors, 1);
  assert.match(traversal.json().rows[0].errors.join(' '), /path is invalid|relative/i);

  sheetValues = [header, row(project.slug, 'ydisk-missing', 'Missing', 'rev-1', JSON.stringify([{ source: 'Yandex Media', path: 'missing.jpg' }]))];
  const missing = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(missing.statusCode, 200, missing.body);
  assert.equal(missing.json().summary.errors, 1);
  assert.match(missing.json().rows[0].errors.join(' '), /Yandex Disk API failed.*404/i);

  assert.ok(metadataCalls >= 5);
  await app.close();
  console.log('CP2-006B Yandex Disk media binding: PASS');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
