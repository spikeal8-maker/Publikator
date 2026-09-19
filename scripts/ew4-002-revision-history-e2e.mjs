import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-ew4-002-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'ew4-002-ci-password';
process.env.APP_MASTER_KEY = 'ew4-002-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const sharp = (await import('sharp')).default;
const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { saveImageVersioned } = await import('../dist/media.js');
const { diffText } = await import('../dist/revision-history.js');
const { snapshotContentRevision } = await import('../dist/content-versioning.js');
const { setPublisherForTests } = await import('../dist/platforms/index.js');
const { buildApp } = await import('../dist/app.js');

migrate();
assert.equal(Number(db.pragma('user_version', { simple: true })), 9);

let publishCalls = 0;
setPublisherForTests('telegram', {
  platform: 'telegram',
  validate() {},
  async publish() {
    publishCalls += 1;
    return { externalId: `unexpected-${publishCalls}` };
  }
});

const app = await buildApp();
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;

async function api(method, url, payload, expected = 200, headers = {}) {
  const response = await app.inject({ method, url, headers: { cookie, ...headers }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
  return response.json();
}

async function createPost(title, body = `${title} body`) {
  return api('POST', '/api/posts', { projectId, title, body, scheduleMode: 'MANUAL' }, 201);
}

function revisions(postId) {
  return db.prepare(`SELECT id,content_version,title,body,editorial_stage,actor_source,restored_from_revision_id,targets_json,media_json,content_media_json
    FROM content_revisions WHERE post_id=? ORDER BY content_version`).all(postId);
}

function assertContinuous(postId, expectedVersion) {
  const post = db.prepare('SELECT content_version FROM posts WHERE id=?').get(postId);
  assert.equal(post.content_version, expectedVersion);
  const versions = revisions(postId).map((row) => row.content_version);
  assert.deepEqual(versions, Array.from({ length: expectedVersion }, (_, index) => index + 1));
}

const atomicCountsBefore = {
  posts: db.prepare('SELECT COUNT(*) AS count FROM posts').get().count,
  targets: db.prepare('SELECT COUNT(*) AS count FROM post_targets').get().count,
  revisions: db.prepare('SELECT COUNT(*) AS count FROM content_revisions').get().count
};
db.exec(`CREATE TEMP TRIGGER ew4_002_fail_initial_revision
  BEFORE INSERT ON content_revisions
  BEGIN
    SELECT RAISE(ABORT, 'forced initial revision failure');
  END;`);
const failedAtomicCreate = await app.inject({
  method: 'POST',
  url: '/api/posts',
  headers: { cookie },
  payload: { projectId, title: 'Atomic rollback probe', body: 'Must rollback', scheduleMode: 'MANUAL' }
});
assert.equal(failedAtomicCreate.statusCode, 500, failedAtomicCreate.body);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM posts WHERE title=?').get('Atomic rollback probe').count, 0);
assert.deepEqual({
  posts: db.prepare('SELECT COUNT(*) AS count FROM posts').get().count,
  targets: db.prepare('SELECT COUNT(*) AS count FROM post_targets').get().count,
  revisions: db.prepare('SELECT COUNT(*) AS count FROM content_revisions').get().count
}, atomicCountsBefore, 'failed initial revision must roll back post and targets');
db.exec('DROP TRIGGER ew4_002_fail_initial_revision');

const atomicPost = await createPost('Atomic create success', 'Atomic body');
assertContinuous(atomicPost.id, 1);
assert.equal(revisions(atomicPost.id)[0].content_version, 1);

const stableAccountId = id('acc');
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`)
  .run(stableAccountId, 'telegram', 'Stable target', encryptJson({ botToken: 'mock', chatId: '@stable' }),
    '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z');

const placeholderPost = await createPost('Placeholder semantics', 'Placeholder body');
const placeholderV1 = revisions(placeholderPost.id)[0];
assert.deepEqual(JSON.parse(placeholderV1.targets_json).map((target) => target.accountId), [stableAccountId]);

const lateAccountId = id('acc');
const lateAccountTime = new Date(Date.now() + 60_000).toISOString();
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`)
  .run(lateAccountId, 'telegram', 'Late inert target', encryptJson({ botToken: 'mock', chatId: '@late' }),
    lateAccountTime, lateAccountTime);

const placeholderRead = await api('GET', `/api/posts/${placeholderPost.id}`);
assert.equal(placeholderRead.content_version, 1);
assert.equal(revisions(placeholderPost.id).length, 1);
const inertRow = db.prepare('SELECT id,enabled,override_text FROM post_targets WHERE post_id=? AND account_id=?')
  .get(placeholderPost.id, lateAccountId);
assert.ok(inertRow);
assert.equal(inertRow.enabled, 0);
assert.equal(inertRow.override_text, null);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM target_renditions WHERE target_id=?').get(inertRow.id).count, 0);

const placeholderDiff = await api('GET', `/api/posts/${placeholderPost.id}/revisions/${placeholderV1.id}/diff`);
assert.deepEqual(placeholderDiff.targets, { added: [], removed: [], changed: [] });
const placeholderReuseV1 = snapshotContentRevision(placeholderPost.id, 1, 'manual');
assert.equal(placeholderReuseV1.id, placeholderV1.id, 'GET-created inert target must not break exact revision reuse');

const placeholderImage = await sharp({
  create: { width: 32, height: 32, channels: 3, background: { r: 70, g: 90, b: 120 } }
}).jpeg().toBuffer();
const placeholderMedia = await saveImageVersioned(placeholderPost.id, 'placeholder.jpg', placeholderImage, 1);
assert.equal(placeholderMedia.contentVersion, 2);
const readyRevisionBefore = db.prepare('SELECT * FROM content_revisions WHERE post_id=? AND content_version=2').get(placeholderPost.id);
assert.ok(readyRevisionBefore);
assert.equal(readyRevisionBefore.editorial_stage, 'DRAFT');
assert.deepEqual(JSON.parse(readyRevisionBefore.targets_json).map((target) => target.accountId), [stableAccountId]);

const readyPayload = (revision) => ({
  id: revision.id,
  post_id: revision.post_id,
  content_version: revision.content_version,
  title: revision.title,
  body: revision.body,
  schedule_mode: revision.schedule_mode,
  scheduled_at: revision.scheduled_at,
  scheduled_at_utc: revision.scheduled_at_utc,
  schedule_timezone: revision.schedule_timezone,
  publication_kind: revision.publication_kind,
  content_format: revision.content_format,
  targets_json: revision.targets_json,
  media_json: revision.media_json,
  content_media_json: revision.content_media_json,
  actor_source: revision.actor_source,
  restored_from_revision_id: revision.restored_from_revision_id,
  created_at: revision.created_at
});
const payloadBeforeReady = readyPayload(readyRevisionBefore);
const placeholderReuseV2 = snapshotContentRevision(placeholderPost.id, 2, 'manual');
assert.equal(placeholderReuseV2.id, readyRevisionBefore.id);

const placeholderReady = await api('POST', `/api/posts/${placeholderPost.id}/ready`, { expectedContentVersion: 2 });
assert.equal(placeholderReady.contentVersion, 2);
assert.equal(placeholderReady.revisionId, readyRevisionBefore.id);
const readyPost = db.prepare('SELECT status,editorial_stage,content_version,ready_revision_id FROM posts WHERE id=?').get(placeholderPost.id);
assert.deepEqual(readyPost, {
  status: 'READY',
  editorial_stage: 'APPROVED',
  content_version: 2,
  ready_revision_id: readyRevisionBefore.id
});
const readyRevisionAfter = db.prepare('SELECT * FROM content_revisions WHERE id=?').get(readyRevisionBefore.id);
assert.equal(readyRevisionAfter.editorial_stage, 'APPROVED');
assert.deepEqual(readyPayload(readyRevisionAfter), payloadBeforeReady, 'READY must only finalize approval metadata');
assert.equal(revisions(placeholderPost.id).length, 2);

const repeatedReady = await api('POST', `/api/posts/${placeholderPost.id}/ready`, { expectedContentVersion: 2 });
assert.equal(repeatedReady.revisionId, readyRevisionBefore.id);
assert.equal(revisions(placeholderPost.id).length, 2, 'repeated READY must be idempotent');

db.prepare('UPDATE social_accounts SET enabled=0,updated_at=? WHERE id IN (?,?)')
  .run(nowIso(), stableAccountId, lateAccountId);

const restorePlaceholderPost = await createPost('Restore placeholder semantics', 'Restore source body');
const restoreSource = revisions(restorePlaceholderPost.id)[0];
const restorePlaceholderEdit = await api('PATCH', `/api/posts/${restorePlaceholderPost.id}`, {
  body: 'Restore changed body',
  expectedContentVersion: 1
});
assert.equal(restorePlaceholderEdit.contentVersion, 2);

const restoreLateAccountId = id('acc');
const restoreLateTime = new Date(Date.now() + 120_000).toISOString();
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`)
  .run(restoreLateAccountId, 'telegram', 'Restore inert target', encryptJson({ botToken: 'mock', chatId: '@restore-inert' }),
    restoreLateTime, restoreLateTime);
await api('GET', `/api/posts/${restorePlaceholderPost.id}`);
const restoreInertRow = db.prepare('SELECT id,enabled,override_text FROM post_targets WHERE post_id=? AND account_id=?')
  .get(restorePlaceholderPost.id, restoreLateAccountId);
assert.ok(restoreInertRow);
assert.equal(restoreInertRow.enabled, 0);
assert.equal(restoreInertRow.override_text, null);

const placeholderRestore = await api(
  'POST',
  `/api/posts/${restorePlaceholderPost.id}/revisions/${restoreSource.id}/restore`,
  { expectedContentVersion: 2 }
);
assert.equal(placeholderRestore.contentVersion, 3);
const restoreCurrent = revisions(restorePlaceholderPost.id).find((row) => row.content_version === 3);
assert.deepEqual(JSON.parse(restoreCurrent.targets_json), [], 'restore revision must exclude inert placeholder targets');
const restoredPlaceholderRow = db.prepare('SELECT enabled,override_text FROM post_targets WHERE post_id=? AND account_id=?')
  .get(restorePlaceholderPost.id, restoreLateAccountId);
assert.deepEqual(restoredPlaceholderRow, { enabled: 0, override_text: null });
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM target_renditions WHERE target_id=?').get(restoreInertRow.id).count, 0);
const restorePlaceholderDiff = await api('GET', `/api/posts/${restorePlaceholderPost.id}/revisions/${restoreSource.id}/diff`);
assert.deepEqual(restorePlaceholderDiff.targets, { added: [], removed: [], changed: [] });

db.prepare('UPDATE social_accounts SET enabled=0,updated_at=? WHERE id=?').run(nowIso(), restoreLateAccountId);

const post = await createPost('Revision A', 'Body A');
assert.equal(post.content_version, 1);
assertContinuous(post.id, 1);
assert.equal(revisions(post.id)[0].actor_source, 'manual');

const v2 = await api('PATCH', `/api/posts/${post.id}`, {
  title: 'Revision B',
  body: 'Line one\nLine B',
  scheduleMode: 'AT',
  scheduledAt: '2026-12-10T09:30:00.000Z',
  scheduleTimezone: 'UTC',
  expectedContentVersion: 1
});
assert.equal(v2.contentVersion, 2);
assertContinuous(post.id, 2);

const accountId = id('acc');
const accountNow = nowIso();
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`)
  .run(accountId, 'telegram', 'Revision target', encryptJson({ botToken: 'mock', chatId: '@revision' }), accountNow, accountNow);

const v3 = await api('PUT', `/api/posts/${post.id}/targets`, {
  accountIds: [accountId],
  expectedContentVersion: 2
});
assert.equal(v3.contentVersion, 3);
assertContinuous(post.id, 3);
const targetId = v3.targets.find((target) => target.account_id === accountId).id;

const v4 = await api('PATCH', `/api/posts/${post.id}/targets/${targetId}/text`, {
  text: 'Target override A',
  expectedContentVersion: 3
});
assert.equal(v4.contentVersion, 4);
assertContinuous(post.id, 4);

const imageA = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 30, g: 80, b: 140 } } }).jpeg().toBuffer();
const imageB = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 140, g: 80, b: 30 } } }).jpeg().toBuffer();
const mediaA = await saveImageVersioned(post.id, 'a.jpg', imageA, 4);
assert.equal(mediaA.contentVersion, 5);
assertContinuous(post.id, 5);
const mediaB = await saveImageVersioned(post.id, 'b.jpg', imageB, 5);
assert.equal(mediaB.contentVersion, 6);
assertContinuous(post.id, 6);

const selectedRevision = revisions(post.id).find((row) => row.content_version === 6);
assert.ok(selectedRevision);
const immutableSelected = JSON.stringify(selectedRevision);

const v7 = await api('PATCH', `/api/posts/${post.id}`, {
  body: 'Line one\nLine C',
  expectedContentVersion: 6
});
assert.equal(v7.contentVersion, 7);
const v8 = await api('PATCH', `/api/posts/${post.id}/targets/${targetId}/text`, {
  text: 'Target override B',
  expectedContentVersion: 7
});
assert.equal(v8.contentVersion, 8);
const v9 = await api('PUT', `/api/posts/${post.id}/media-order`, {
  mediaIds: [mediaB.media.id, mediaA.media.id],
  expectedContentVersion: 8
});
assert.equal(v9.contentVersion, 9);
assertContinuous(post.id, 9);

const beforeRestoreRevision = revisions(post.id).find((row) => row.content_version === 6);
assert.equal(JSON.stringify(beforeRestoreRevision), immutableSelected, 'older revision must remain immutable');

const list = await api('GET', `/api/posts/${post.id}/revisions?limit=3`);
assert.deepEqual(list.items.map((item) => item.contentVersion), [9,8,7]);
assert.equal(list.nextBeforeVersion, 7);
const nextPage = await api('GET', `/api/posts/${post.id}/revisions?limit=3&beforeVersion=${list.nextBeforeVersion}`);
assert.deepEqual(nextPage.items.map((item) => item.contentVersion), [6,5,4]);

const detail = await api('GET', `/api/posts/${post.id}/revisions/${selectedRevision.id}`);
assert.equal(detail.contentVersion, 6);
assert.equal(detail.actorSource, 'manual');
assert.equal(detail.body, 'Line one\nLine B');
assert.equal(detail.targets.find((target) => target.accountId === accountId).overrideText, 'Target override A');
assert.deepEqual(detail.contentMedia.map((item) => item.mediaId), [mediaA.media.id, mediaB.media.id]);

const diff = await api('GET', `/api/posts/${post.id}/revisions/${selectedRevision.id}/diff`);
assert.equal(diff.text.body.changed, true);
assert.ok(diff.text.body.diff.lines.some((line) => line.type === 'removed' && line.text === 'Line B'));
assert.ok(diff.text.body.diff.lines.some((line) => line.type === 'added' && line.text === 'Line C'));
assert.equal(diff.targets.changed.length, 1);
assert.equal(diff.targets.changed[0].before.overrideText, 'Target override A');
assert.equal(diff.targets.changed[0].after.overrideText, 'Target override B');
assert.equal(diff.media.changed, true);
assert.equal(diff.restoreCompatibility.canRestore, true);

const bounded = diffText(Array.from({ length: 401 }, (_, i) => `before-${i}`).join('\n'), 'after');
assert.equal(bounded.mode, 'fallback');

const ready = await api('POST', `/api/posts/${post.id}/ready`, { expectedContentVersion: 9 });
assert.equal(ready.contentVersion, 9);
assert.equal(revisions(post.id).length, 9, 'READY must reuse exact current revision');
let postRow = await api('GET', `/api/posts/${post.id}`);
assert.equal(postRow.status, 'READY');
assert.equal(postRow.ready_revision_id, ready.revisionId);

const restore = await api('POST', `/api/posts/${post.id}/revisions/${selectedRevision.id}/restore`, {
  expectedContentVersion: 9
});
assert.equal(restore.contentVersion, 10);
assertContinuous(post.id, 10);
postRow = await api('GET', `/api/posts/${post.id}`);
assert.equal(postRow.title, 'Revision B');
assert.equal(postRow.body, 'Line one\nLine B');
assert.equal(postRow.status, 'DRAFT');
assert.equal(postRow.editorial_stage, 'DRAFT');
assert.equal(postRow.ready_revision_id, null);
assert.deepEqual(postRow.media.map((item) => item.id), [mediaA.media.id, mediaB.media.id]);
assert.equal(postRow.targets.find((target) => target.account_id === accountId).override_text, 'Target override A');

const restoredRevision = revisions(post.id).at(-1);
assert.equal(restoredRevision.content_version, 10);
assert.equal(restoredRevision.actor_source, 'manual_restore');
assert.equal(restoredRevision.restored_from_revision_id, selectedRevision.id);
assert.equal(JSON.stringify(revisions(post.id).find((row) => row.content_version === 6)), immutableSelected, 'restore must not rewrite source revision');

const restoreEvent = db.prepare("SELECT data_json FROM publication_events WHERE post_id=? AND event_type='post_revision_restored' ORDER BY created_at DESC LIMIT 1").get(post.id);
assert.ok(restoreEvent);
const restoreEventData = JSON.parse(restoreEvent.data_json);
assert.equal(restoreEventData.restoredRevisionContentVersion, 6);
assert.equal(restoreEventData.previousContentVersion, 9);
assert.equal(restoreEventData.resultingContentVersion, 10);
assert.equal(restoreEventData.actorSource, 'manual_restore');

const stale = await api('POST', `/api/posts/${post.id}/revisions/${selectedRevision.id}/restore`, {
  expectedContentVersion: 9
}, 409);
assert.equal(stale.code, 'REVISION_CONFLICT');

const noMediaRevision = revisions(post.id).find((row) => row.content_version === 4);
const mediaDiff = await api('GET', `/api/posts/${post.id}/revisions/${noMediaRevision.id}/diff`);
assert.equal(mediaDiff.restoreCompatibility.code, 'REVISION_MEDIA_INCOMPATIBLE');
const mediaBlocked = await api('POST', `/api/posts/${post.id}/revisions/${noMediaRevision.id}/restore`, {
  expectedContentVersion: 10
}, 409);
assert.equal(mediaBlocked.code, 'REVISION_MEDIA_INCOMPATIBLE');
assert.equal((await api('GET', `/api/posts/${post.id}`)).content_version, 10, 'media-incompatible restore must be all-or-nothing');

db.prepare("UPDATE posts SET status='PUBLISHED',editorial_stage='APPROVED' WHERE id=?").run(post.id);
const publishedDiff = await api('GET', `/api/posts/${post.id}/revisions/${selectedRevision.id}/diff`);
assert.equal(publishedDiff.restoreCompatibility.code, 'REVISION_PUBLISHED_IMMUTABLE');
const publishedBlocked = await api('POST', `/api/posts/${post.id}/revisions/${selectedRevision.id}/restore`, {
  expectedContentVersion: 10
}, 409);
assert.equal(publishedBlocked.code, 'REVISION_PUBLISHED_IMMUTABLE');

const missingAccountId = id('acc');
const missingNow = nowIso();
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`).run(missingAccountId, 'telegram', 'Historical target', encryptJson({ botToken: 'mock', chatId: '@historical' }), missingNow, missingNow);
const targetPost = await createPost('Target compatibility');
const targetPostV2 = await api('PUT', `/api/posts/${targetPost.id}/targets`, {
  accountIds: [missingAccountId],
  expectedContentVersion: 1
});
assert.equal(targetPostV2.contentVersion, 2);
const targetRevision = revisions(targetPost.id).find((row) => row.content_version === 2);
const targetPostV3 = await api('PATCH', `/api/posts/${targetPost.id}`, {
  body: 'Changed after historical target',
  expectedContentVersion: 2
});
assert.equal(targetPostV3.contentVersion, 3);
db.prepare('DELETE FROM post_targets WHERE post_id=? AND account_id=?').run(targetPost.id, missingAccountId);
db.prepare('DELETE FROM social_accounts WHERE id=?').run(missingAccountId);
const targetBlocked = await api('POST', `/api/posts/${targetPost.id}/revisions/${targetRevision.id}/restore`, {
  expectedContentVersion: 3
}, 409);
assert.equal(targetBlocked.code, 'REVISION_TARGET_INCOMPATIBLE');

assert.equal(publishCalls, 0, 'revision restore must never publish externally');

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'EW4-002',
  schemaVersion: 9,
  continuousRevisionVersions: true,
  actorPropagation: true,
  immutableRevisions: true,
  pagination: true,
  detail: true,
  diff: true,
  boundedTextDiffFallback: true,
  optimisticRestoreConflict: true,
  monotonicRestoreVersion: true,
  restoreResetsReady: true,
  targetRestore: true,
  mediaOrderRestore: true,
  mediaIncompatibleBlocked: true,
  targetIncompatibleBlocked: true,
  publishedRestoreBlocked: true,
  restoredFromMetadata: true,
  auditEvent: true,
  noExternalPublication: true,
  atomicInitialCreateRollback: true,
  inertPlaceholderIgnoredByRevisionSemantics: true,
  restoreIgnoresInertPlaceholder: true,
  readyRevisionApprovalFinalizedAtomically: true
}, null, 2));

await app.close();
db.close();
await fs.rm(dataDir, { recursive: true, force: true });
