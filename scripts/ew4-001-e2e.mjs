import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-ew4-001-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'ew4-001-ci-password';
process.env.APP_MASTER_KEY = 'ew4-001-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { config } = await import('../dist/config.js');
const { snapshotContentRevision, markReadyRevision } = await import('../dist/content-versioning.js');
const { buildApp } = await import('../dist/app.js');

migrate();
const app = await buildApp();
await app.ready();

const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;

async function request(method, url, payload) {
  const response = await app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  return response;
}

async function createPost(title) {
  const response = await request('POST', '/api/posts', {
    projectId,
    title,
    body: `${title} body`,
    scheduleMode: 'AT',
    scheduledAt: '2026-12-01T12:00:00.000Z',
    scheduleTimezone: 'UTC'
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

function forceReady(post) {
  const revision = snapshotContentRevision(post.id, post.content_version, 'ew4-001-fixture');
  markReadyRevision(post.id, post.content_version, revision.id);
  return revision.id;
}

const future = await createPost('Future ready');
const futureRevisionId = forceReady(future);
let row = db.prepare('SELECT * FROM posts WHERE id=?').get(future.id);
assert.equal(row.status, 'READY');
assert.equal(row.editorial_stage, 'APPROVED');

const trashed = await request('POST', `/api/posts/${future.id}/trash`, { expectedContentVersion: future.content_version });
assert.equal(trashed.statusCode, 200, trashed.body);
let trashBody = trashed.json();
assert.equal(trashBody.status, 'DRAFT');
assert.equal(trashBody.editorialStage, 'TRASHED');
assert.equal(trashBody.contentVersion, future.content_version + 1);
row = db.prepare('SELECT * FROM posts WHERE id=?').get(future.id);
assert.equal(row.ready_revision_id, null);
assert.equal(row.scheduled_at_utc, '2026-12-01T12:00:00.000Z');
assert.equal(db.prepare('SELECT id FROM content_revisions WHERE id=?').get(futureRevisionId).id, futureRevisionId);

const blockedEdit = await request('PATCH', `/api/posts/${future.id}`, {
  expectedContentVersion: trashBody.contentVersion,
  title: 'Should not edit'
});
assert.equal(blockedEdit.statusCode, 409, blockedEdit.body);
const blockedReady = await request('POST', `/api/posts/${future.id}/ready`, { expectedContentVersion: trashBody.contentVersion });
assert.equal(blockedReady.statusCode, 409, blockedReady.body);

const trashList = await request('GET', '/api/editorial/posts?view=trash');
assert.equal(trashList.statusCode, 200, trashList.body);
assert.ok(trashList.json().some((post) => post.id === future.id));
const activeListWhileTrashed = await request('GET', '/api/editorial/posts?view=active');
assert.ok(!activeListWhileTrashed.json().some((post) => post.id === future.id));

const restored = await request('POST', `/api/posts/${future.id}/restore`, { expectedContentVersion: trashBody.contentVersion });
assert.equal(restored.statusCode, 200, restored.body);
let restoreBody = restored.json();
assert.equal(restoreBody.status, 'DRAFT');
assert.equal(restoreBody.editorialStage, 'DRAFT');
assert.equal(restoreBody.contentVersion, trashBody.contentVersion + 1);
row = db.prepare('SELECT * FROM posts WHERE id=?').get(future.id);
assert.equal(row.ready_revision_id, null);
assert.equal(row.status, 'DRAFT');

const archived = await request('POST', `/api/posts/${future.id}/archive`, { expectedContentVersion: restoreBody.contentVersion });
assert.equal(archived.statusCode, 200, archived.body);
let archiveBody = archived.json();
assert.equal(archiveBody.editorialStage, 'ARCHIVED');
assert.equal(archiveBody.status, 'DRAFT');
const archiveList = await request('GET', '/api/editorial/posts?view=archive');
assert.ok(archiveList.json().some((post) => post.id === future.id));

const restoredArchive = await request('POST', `/api/posts/${future.id}/restore`, { expectedContentVersion: archiveBody.contentVersion });
assert.equal(restoredArchive.statusCode, 200, restoredArchive.body);
restoreBody = restoredArchive.json();
assert.equal(restoreBody.editorialStage, 'DRAFT');

const published = await createPost('Published history');
const publishedRevisionId = forceReady(published);
db.prepare("UPDATE posts SET status='PUBLISHED',editorial_stage='APPROVED' WHERE id=?").run(published.id);
const publishedArchive = await request('POST', `/api/posts/${published.id}/archive`, { expectedContentVersion: published.content_version });
assert.equal(publishedArchive.statusCode, 200, publishedArchive.body);
assert.equal(publishedArchive.json().contentVersion, published.content_version);
row = db.prepare('SELECT * FROM posts WHERE id=?').get(published.id);
assert.equal(row.status, 'PUBLISHED');
assert.equal(row.editorial_stage, 'ARCHIVED');
assert.equal(row.ready_revision_id, publishedRevisionId);
assert.equal(row.content_version, published.content_version);
const publishedTrash = await request('POST', `/api/posts/${published.id}/trash`, { expectedContentVersion: published.content_version });
assert.equal(publishedTrash.statusCode, 409, publishedTrash.body);
const publishedRestore = await request('POST', `/api/posts/${published.id}/restore`, { expectedContentVersion: published.content_version });
assert.equal(publishedRestore.statusCode, 200, publishedRestore.body);
row = db.prepare('SELECT * FROM posts WHERE id=?').get(published.id);
assert.equal(row.status, 'PUBLISHED');
assert.equal(row.editorial_stage, 'APPROVED');
assert.equal(row.ready_revision_id, publishedRevisionId);

const doomed = await createPost('Permanent delete');
const mediaId = id('med');
const relativePath = `${doomed.id}/${mediaId}.jpg`;
const mediaDir = path.join(config.mediaDir, doomed.id);
const mediaPath = path.join(config.mediaDir, relativePath);
await fs.mkdir(mediaDir, { recursive: true });
const bytes = Buffer.from('ew4-001-media');
await fs.writeFile(mediaPath, bytes);
db.prepare(`INSERT INTO media
  (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
  VALUES (?,?,?,?,?,?,?,?,?,?,0)`)
  .run(mediaId, doomed.id, 'fixture.jpg', relativePath, 'image/jpeg', bytes.byteLength, 1, 1,
    crypto.createHash('sha256').update(bytes).digest('hex'), nowIso());

const doomedTrash = await request('POST', `/api/posts/${doomed.id}/trash`, { expectedContentVersion: doomed.content_version });
assert.equal(doomedTrash.statusCode, 200, doomedTrash.body);
const doomedVersion = doomedTrash.json().contentVersion;
const missingConfirmation = await request('DELETE', `/api/posts/${doomed.id}/permanent`, { expectedContentVersion: doomedVersion });
assert.equal(missingConfirmation.statusCode, 400, missingConfirmation.body);
const deleted = await request('DELETE', `/api/posts/${doomed.id}/permanent`, { expectedContentVersion: doomedVersion, confirm: true });
assert.equal(deleted.statusCode, 200, deleted.body);
assert.equal(db.prepare('SELECT 1 FROM posts WHERE id=?').get(doomed.id), undefined);
await assert.rejects(fs.stat(mediaPath));
const deleteEvent = db.prepare("SELECT * FROM publication_events WHERE event_type='post_deleted_permanently' ORDER BY created_at DESC LIMIT 1").get();
assert.ok(deleteEvent);
assert.equal(deleteEvent.post_id, null);
assert.match(String(deleteEvent.data_json), new RegExp(doomed.id));

const inspector = await request('GET', `/api/editorial/posts/${future.id}`);
assert.equal(inspector.statusCode, 200, inspector.body);
assert.equal(inspector.json().actions.edit, true);
assert.equal(inspector.json().actions.trash, true);
assert.ok(Array.isArray(inspector.json().recentEvents));

const auditTypes = db.prepare(`SELECT event_type FROM publication_events
  WHERE post_id IN (?,?) ORDER BY created_at`).all(future.id, published.id).map((event) => event.event_type);
for (const required of ['post_trashed', 'post_restored', 'post_archived', 'post_unarchived']) assert.ok(auditTypes.includes(required), required);

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'EW4-001',
  safeTrashInvalidatesReady: true,
  inactiveEditBlocked: true,
  restoreReturnsDraft: true,
  publishedArchivePreservesRevision: true,
  permanentDeleteConfirmedAndCleansMedia: true,
  auditTrail: true,
  inspectorContract: true
}, null, 2));

await app.close();
db.close();
await fs.rm(dataDir, { recursive: true, force: true });
