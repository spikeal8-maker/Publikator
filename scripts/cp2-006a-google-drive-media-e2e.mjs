import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cp2-006a-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cp2-006a-acceptance-password';
process.env.APP_MASTER_KEY = 'cp2-006a-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const serviceAccount = {
  type: 'service_account',
  client_email: 'publikator-media@test-project.iam.gserviceaccount.com',
  private_key: privateKeyPem,
  token_uri: 'https://oauth2.googleapis.com/token'
};

const header = [
  'schema_version', 'external_id', 'action', 'project', 'template_key', 'internal_title', 'body',
  'publication_kind', 'content_format', 'schedule_mode', 'scheduled_at', 'timezone', 'targets',
  'telegram_body', 'vk_body', 'max_body', 'instagram_body', 'media', 'tags', 'source_note', 'source_revision'
];

const rootFolderId = 'root_folder_12345';
let imageBuffer = await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#336699' } }).jpeg({ quality: 90 }).toBuffer();
let imageRevision = 'md5-image-v1';
let imageModified = '2026-09-15T10:00:00Z';
let sheetValues = [];
let duplicateImage = false;
let driveListCalls = 0;
let driveDownloadCalls = 0;
let sheetValueCalls = 0;
const writeBackBodies = [];

const row = (projectSlug, externalId, title, revision, media) => [
  '3', externalId, 'UPSERT', projectSlug, '', title, `${title} body`, 'FEED', 'IMAGE', 'MANUAL', '', 'UTC', '[]',
  '', '', '', '', media, '', '', revision
];

function oauthScope(init) {
  const body = new URLSearchParams(String(init.body || ''));
  const assertion = body.get('assertion') || '';
  const parts = assertion.split('.');
  if (parts.length !== 3) return '';
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).scope || '';
}

function driveFile(id = 'img-1') {
  return {
    id,
    name: 'lesson-01.jpg',
    mimeType: 'image/jpeg',
    size: String(imageBuffer.length),
    md5Checksum: imageRevision,
    modifiedTime: imageModified,
    parents: [rootFolderId],
    capabilities: { canDownload: true }
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') {
    const scope = oauthScope(init);
    assert.equal(init.method, 'POST');
    const token = scope.includes('/auth/drive') ? 'drive-token' : scope.includes('/auth/spreadsheets') ? 'sheet-token' : 'unknown-token';
    assert.notEqual(token, 'unknown-token', `unexpected Google scope ${scope}`);
    return new Response(JSON.stringify({ access_token: token, expires_in: 3600, token_type: 'Bearer' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }

  const parsed = new URL(url);
  if (parsed.hostname === 'sheets.googleapis.com') {
    assert.match(String(init.headers?.authorization ?? init.headers?.Authorization ?? ''), /^Bearer sheet-token$/);
    if (url.includes('?fields=properties.title,sheets.properties')) {
      return new Response(JSON.stringify({ properties: { title: 'Media Sheet' }, sheets: [{ properties: { sheetId: 0, title: 'Posts' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (url.endsWith('/values:batchUpdate')) {
      writeBackBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ totalUpdatedCells: 4 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/values/')) {
      sheetValueCalls += 1;
      return new Response(JSON.stringify({ range: "'Posts'!A1:U10001", majorDimension: 'ROWS', values: sheetValues }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  }

  if (parsed.hostname === 'www.googleapis.com' && parsed.pathname.startsWith('/drive/v3/files')) {
    assert.match(String(init.headers?.authorization ?? init.headers?.Authorization ?? ''), /^Bearer drive-token$/);
    if (parsed.pathname === `/drive/v3/files/${rootFolderId}`) {
      return new Response(JSON.stringify({ id: rootFolderId, name: 'ASA Media', mimeType: 'application/vnd.google-apps.folder', capabilities: { canDownload: true } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/drive/v3/files' && parsed.searchParams.has('q')) {
      driveListCalls += 1;
      const q = parsed.searchParams.get('q') || '';
      if (q.includes("name = 'missing.jpg'")) return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (q.includes("name = 'lesson-01.jpg'")) {
        const files = duplicateImage ? [driveFile('img-1'), driveFile('img-2')] : [driveFile('img-1')];
        return new Response(JSON.stringify({ files }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected Drive q: ${q}`);
    }
    if (parsed.pathname === '/drive/v3/files/img-1' && parsed.searchParams.get('alt') === 'media') {
      driveDownloadCalls += 1;
      return new Response(imageBuffer, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(imageBuffer.length) } });
    }
    if (parsed.pathname === '/drive/v3/files/img-1') {
      return new Response(JSON.stringify(driveFile('img-1')), { status: 200, headers: { 'content-type': 'application/json' } });
    }
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
  const app = await buildApp();
  await app.ready();
  const anonymous = await app.inject({ method: 'GET', url: '/api/google-drive/connectors' });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const request = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });

  const inspectDrive = await request('POST', '/api/google-drive/inspect', { credentials: serviceAccount, rootFolder: `https://drive.google.com/drive/folders/${rootFolderId}` });
  assert.equal(inspectDrive.statusCode, 200, inspectDrive.body);
  assert.equal(inspectDrive.json().rootFolderName, 'ASA Media');

  const createDrive = await request('POST', '/api/google-drive/connectors', {
    name: 'ASA Media', rootFolder: rootFolderId, credentials: serviceAccount
  });
  assert.equal(createDrive.statusCode, 201, createDrive.body);
  const driveConnector = createDrive.json().connector;
  assert.equal(driveConnector.type, 'google_drive');
  const storedDrive = db.prepare('SELECT config_json,credentials_encrypted FROM ingestion_connectors WHERE id=?').get(driveConnector.id);
  assert.ok(storedDrive.credentials_encrypted.startsWith('v1:'));
  assert.ok(!storedDrive.credentials_encrypted.includes('BEGIN PRIVATE KEY'));
  assert.ok(!storedDrive.config_json.includes('private_key'));
  const driveList = await request('GET', '/api/google-drive/connectors');
  assert.equal(JSON.stringify(driveList.json()).includes('private_key'), false);
  const driveTest = await request('POST', `/api/google-drive/connectors/${driveConnector.id}/test`, {});
  assert.equal(driveTest.statusCode, 200, driveTest.body);

  const createSheet = await request('POST', '/api/google-sheets/connectors', {
    name: 'Editorial Sheet', spreadsheetId: 'spreadsheet_test_12345', sheetName: 'Posts', writeBack: true, credentials: serviceAccount
  });
  assert.equal(createSheet.statusCode, 201, createSheet.body);
  const sheetConnector = createSheet.json().connector;
  const mediaCell = JSON.stringify([{ source: 'ASA Media', path: 'lesson-01.jpg' }]);
  sheetValues = [header, row(project.slug, 'sheet-media-001', 'Drive image', 'rev-1', mediaCell)];

  const preview1 = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(preview1.statusCode, 200, preview1.body);
  assert.equal(preview1.json().summary.newRows, 1);
  assert.equal(preview1.json().managedMediaRows, 1);
  assert.match(preview1.json().mediaSnapshotSha256, /^[a-f0-9]{64}$/);
  assert.equal(preview1.json().rows[0].mediaPreview.items[0].fileName, 'lesson-01.jpg');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 0, 'preview must not create posts');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media').get().count, 0, 'preview must not create media');

  const missingMediaSha = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/apply`, { confirm: 'IMPORT', previewSha: preview1.json().sourceSnapshotSha256 });
  assert.equal(missingMediaSha.statusCode, 409, missingMediaSha.body);
  assert.match(missingMediaSha.json().error, /cloud media.*preview/i);

  db.exec(`CREATE TRIGGER safety_001_force_media_failure BEFORE INSERT ON media
    BEGIN SELECT RAISE(ABORT,'forced atomic media failure'); END;`);
  const failedAtomicApply = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/apply`, {
    confirm: 'IMPORT', previewSha: preview1.json().sourceSnapshotSha256, mediaPreviewSha: preview1.json().mediaSnapshotSha256
  });
  assert.equal(failedAtomicApply.statusCode, 409, failedAtomicApply.body);
  assert.match(failedAtomicApply.json().error, /forced atomic media failure/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 0, 'failed cloud apply must roll back base post');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media').get().count, 0, 'failed cloud apply must roll back media rows');
  const stagedAfterFailure = await fs.readdir(path.join(dataDir, 'media'), { recursive: true }).catch(() => []);
  assert.equal(stagedAfterFailure.filter((name) => String(name).endsWith('.jpg')).length, 0, 'failed cloud apply must remove staged files');
  db.exec('DROP TRIGGER safety_001_force_media_failure');

  const apply1 = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/apply`, {
    confirm: 'IMPORT', previewSha: preview1.json().sourceSnapshotSha256, mediaPreviewSha: preview1.json().mediaSnapshotSha256
  });
  assert.equal(apply1.statusCode, 200, apply1.body);
  assert.equal(apply1.json().created, 1);
  assert.equal(apply1.json().media.syncedRows, 1);
  let post = db.prepare("SELECT * FROM posts WHERE source_type='google_sheets' AND source_ref=?").get(JSON.stringify([`gs:${sheetConnector.id}`, 'sheet-media-001']));
  assert.ok(post);
  assert.equal(post.status, 'DRAFT');
  assert.equal(post.content_version, post.imported_content_version, 'cloud media import must converge imported version');
  let mediaRows = db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order').all(post.id);
  assert.equal(mediaRows.length, 1);
  assert.equal(mediaRows[0].mime_type, 'image/jpeg');
  assert.equal(mediaRows[0].original_name, 'lesson-01.jpg');
  assert.equal((await fs.stat(path.join(dataDir, 'media', mediaRows[0].relative_path))).isFile(), true);
  assert.ok(driveDownloadCalls >= 1);
  assert.ok(writeBackBodies.length >= 1);

  const previewUnchanged = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(previewUnchanged.statusCode, 200, previewUnchanged.body);
  assert.equal(previewUnchanged.json().summary.unchangedRows, 1);
  const downloadsBeforeRepeat = driveDownloadCalls;
  const repeat = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/apply`, {
    confirm: 'IMPORT', previewSha: previewUnchanged.json().sourceSnapshotSha256, mediaPreviewSha: previewUnchanged.json().mediaSnapshotSha256
  });
  assert.equal(repeat.statusCode, 200, repeat.body);
  assert.equal(repeat.json().unchanged, 1);
  assert.equal(driveDownloadCalls, downloadsBeforeRepeat, 'unchanged media must not be downloaded again during apply');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media WHERE post_id=?').get(post.id).count, 1, 'repeat apply must not duplicate media');

  imageBuffer = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: '#993333' } }).jpeg({ quality: 88 }).toBuffer();
  imageRevision = 'md5-image-v2';
  imageModified = '2026-09-15T11:00:00Z';
  sheetValues = [header, row(project.slug, 'sheet-media-001', 'Drive image', 'rev-2', mediaCell)];
  const replacePreview = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(replacePreview.statusCode, 200, replacePreview.body);
  assert.equal(replacePreview.json().summary.updateRows, 1);
  const replaceApply = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/apply`, {
    confirm: 'IMPORT', previewSha: replacePreview.json().sourceSnapshotSha256, mediaPreviewSha: replacePreview.json().mediaSnapshotSha256
  });
  assert.equal(replaceApply.statusCode, 200, replaceApply.body);
  mediaRows = db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order').all(post.id);
  assert.equal(mediaRows.length, 1, 'remote media update must replace, not append');
  assert.equal(mediaRows[0].width, 1080);
  assert.equal(mediaRows[0].height, 1080);

  post = db.prepare('SELECT * FROM posts WHERE id=?').get(post.id);
  db.prepare('UPDATE posts SET title=?,content_version=content_version+1 WHERE id=?').run('Manual local edit', post.id);
  const localConflict = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(localConflict.statusCode, 200, localConflict.body);
  assert.equal(localConflict.json().summary.conflicts, 1, 'local edit must conflict even if source payload is otherwise unchanged');

  sheetValues = [header, row(project.slug, 'sheet-traversal', 'Traversal', 'rev-1', JSON.stringify([{ source: 'ASA Media', path: '../secret.jpg' }]))];
  const traversal = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(traversal.statusCode, 200, traversal.body);
  assert.equal(traversal.json().summary.errors, 1);
  assert.match(traversal.json().rows[0].errors.join(' '), /path is invalid|relative/i);

  sheetValues = [header, row(project.slug, 'sheet-missing', 'Missing', 'rev-1', JSON.stringify([{ source: 'ASA Media', path: 'missing.jpg' }]))];
  const missing = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(missing.statusCode, 200, missing.body);
  assert.equal(missing.json().summary.errors, 1);
  assert.match(missing.json().rows[0].errors.join(' '), /not found/i);

  duplicateImage = true;
  sheetValues = [header, row(project.slug, 'sheet-ambiguous', 'Ambiguous', 'rev-1', mediaCell)];
  const ambiguous = await request('POST', `/api/google-sheets/connectors/${sheetConnector.id}/preview`, {});
  assert.equal(ambiguous.statusCode, 200, ambiguous.body);
  assert.equal(ambiguous.json().summary.errors, 1);
  assert.match(ambiguous.json().rows[0].errors.join(' '), /ambiguous/i);
  duplicateImage = false;

  assert.ok(driveListCalls >= 5);
  assert.ok(sheetValueCalls >= 8);
  await app.close();
  console.log('CP2-006A Google Drive media binding: PASS');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
