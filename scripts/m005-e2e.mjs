import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-m0-005-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'm0-005-ci-password';
process.env.APP_MASTER_KEY = 'm0-005-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const time = await import('../dist/schedule-time.js');
const delivery = await import('../dist/delivery-foundation.js');
const { snapshotContentRevision, revisionTargets } = await import('../dist/content-versioning.js');
const { buildApp } = await import('../dist/app.js');
const sharp = (await import('sharp')).default;
const { saveImageVersioned, deleteMediaVersioned } = await import('../dist/media.js');

migrate();
assert.equal(Number(db.pragma('user_version', { simple: true })), 7);
assert.throws(() => time.resolveLocalSchedule('2026-03-08T02:30:00', 'America/New_York'), /does not exist/i);
assert.throws(() => time.resolveLocalSchedule('2026-11-01T01:30:00', 'America/New_York'), /ambiguous/i);
const earlier = time.resolveLocalSchedule('2026-11-01T01:30:00', 'America/New_York', 'earlier');
const later = time.resolveLocalSchedule('2026-11-01T01:30:00', 'America/New_York', 'later');
assert.notEqual(earlier.scheduledAtUtc, later.scheduledAtUtc);
assert.equal(earlier.scheduleTimezone, 'America/New_York');

const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const accountId = id('acc');
const now = nowIso();
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`)
  .run(accountId, 'telegram', 'M0-005 Telegram', encryptJson({ botToken: 'mock', chatId: '@mock' }), now, now);

const app = await buildApp();
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];
const create = await app.inject({ method: 'POST', url: '/api/posts', headers: { cookie }, payload: {
  projectId, title: 'Queue post', body: 'Body', scheduleMode: 'QUEUE'
} });
assert.equal(create.statusCode, 201, create.body);
let post = create.json();
assert.equal(post.schedule_mode, 'QUEUE');

const denied = await app.inject({ method: 'PATCH', url: `/api/posts/${post.id}`, headers: { cookie }, payload: {
  expectedContentVersion: post.content_version, scheduleMode: 'AT',
  scheduledAtLocal: '2026-11-02T10:00:00', scheduleTimezone: 'America/New_York'
} });
assert.equal(denied.statusCode, 409, denied.body);
assert.equal(denied.json().error, 'QUEUE_TO_AT_CONFIRMATION_REQUIRED');

const converted = await app.inject({ method: 'PATCH', url: `/api/posts/${post.id}`, headers: { cookie }, payload: {
  expectedContentVersion: post.content_version, scheduleMode: 'AT', confirmQueueToAt: true,
  scheduledAtLocal: '2026-11-02T10:00:00', scheduleTimezone: 'America/New_York'
} });
assert.equal(converted.statusCode, 200, converted.body);
post = converted.json().post;
assert.equal(post.schedule_mode, 'AT');
assert.equal(post.schedule_timezone, 'America/New_York');
assert.match(post.scheduled_at_utc, /Z$/);
assert.equal(post.scheduled_at, post.scheduled_at_utc);

const timezonePreserved = await app.inject({ method: 'PATCH', url: `/api/posts/${post.id}`, headers: { cookie }, payload: {
  expectedContentVersion: post.content_version, title: 'Queue post edited', scheduleMode: 'AT', scheduleTimezone: 'Europe/Berlin'
} });
assert.equal(timezonePreserved.statusCode, 200, timezonePreserved.body);
post = timezonePreserved.json().post;
assert.equal(post.schedule_timezone, 'America/New_York');

const target = db.prepare('SELECT id FROM post_targets WHERE post_id=? AND account_id=?').get(post.id, accountId);
assert.ok(target?.id);

const canonical = {
  textRichJson: null, textPlain: 'Canonical', publicationKind: 'FEED', contentFormat: 'IMAGE',
  mediaPlanJson: '[1]', optionsJson: '{"comments":true}'
};
const resolved = delivery.resolveTargetRendition(canonical, { textPlain: 'Telegram text', publicationKind: 'STORY' });
assert.equal(resolved.textPlain, 'Telegram text');
assert.equal(resolved.publicationKind, 'STORY');
assert.equal(resolved.contentFormat, 'IMAGE');
assert.equal(resolved.mediaPlanJson, '[1]');
const renditionEdit = delivery.saveTargetRendition(target.id, { textPlain: 'Telegram text', publicationKind: 'STORY', contentFormat: 'STORY_SEQUENCE' }, post.content_version);
assert.equal(delivery.getTargetRendition(target.id).contentFormat, 'STORY_SEQUENCE');
assert.throws(() => delivery.saveTargetRendition(target.id, { textPlain: 'stale' }, post.content_version), /ожидалась|текущая/i);
post.content_version = renditionEdit.contentVersion;
const revision = snapshotContentRevision(post.id, post.content_version, 'm0-005-test');
assert.equal(revision.schedule_timezone, 'America/New_York');
assert.equal(revision.scheduled_at_utc, post.scheduled_at_utc);
const revisionTarget = revisionTargets(revision).find((item) => item.targetId === target.id);
assert.equal(revisionTarget.rendition.contentFormat, 'STORY_SEQUENCE');

const units = delivery.ensurePublicationUnits(target.id, revision.id, ['STORY','STORY','STORY','STORY','STORY']);
assert.equal(units.length, 5);
const first = delivery.claimNextPublicationUnit(target.id);
assert.equal(first.unit_index, 0);
delivery.markPublicationUnitPublished(first.id, 'story-1');
const second = delivery.claimNextPublicationUnit(target.id);
assert.equal(second.unit_index, 1);
delivery.markPublicationUnitPublished(second.id, 'story-2');
const beforeRecovery = delivery.listPublicationUnits(target.id);
assert.equal(beforeRecovery[0].attempts, 1);
assert.equal(beforeRecovery[1].attempts, 1);

const third = delivery.claimNextPublicationUnit(target.id);
assert.equal(third.unit_index, 2);
delivery.markPublicationUnitRecoveryNeeded(third.id, 'unknown external outcome');
assert.equal(db.prepare('SELECT state FROM post_targets WHERE id=?').get(target.id).state, 'RECOVERY_NEEDED');
assert.throws(() => delivery.claimNextPublicationUnit(target.id), /unresolved/i);
const blocked = delivery.listPublicationUnits(target.id);
assert.equal(blocked[0].state, 'PUBLISHED');
assert.equal(blocked[1].state, 'PUBLISHED');
assert.equal(blocked[3].state, 'PENDING');
assert.equal(blocked[4].state, 'PENDING');

delivery.confirmPublicationUnitNotPublished(third.id);
const retriedThird = delivery.claimNextPublicationUnit(target.id);
assert.equal(retriedThird.id, third.id);
assert.equal(retriedThird.attempts, 2);
delivery.markPublicationUnitPublished(retriedThird.id, 'story-3');

const fourth = delivery.claimNextPublicationUnit(target.id);
assert.equal(fourth.unit_index, 3);
delivery.markPublicationUnitFailed(fourth.id, 'known failure');
assert.throws(() => delivery.claimNextPublicationUnit(target.id), /failed publication unit/i);
delivery.retryFailedPublicationUnit(fourth.id);
const retriedFourth = delivery.claimNextPublicationUnit(target.id);
assert.equal(retriedFourth.id, fourth.id);
delivery.markPublicationUnitPublished(retriedFourth.id, 'story-4');
const fifth = delivery.claimNextPublicationUnit(target.id);
assert.equal(fifth.unit_index, 4);
delivery.markPublicationUnitPublished(fifth.id, 'story-5');
assert.equal(db.prepare('SELECT state FROM post_targets WHERE id=?').get(target.id).state, 'PUBLISHED');
const afterRecovery = delivery.listPublicationUnits(target.id);
assert.equal(afterRecovery[0].external_id, 'story-1');
assert.equal(afterRecovery[1].external_id, 'story-2');
assert.equal(afterRecovery[0].attempts, 1);
assert.equal(afterRecovery[1].attempts, 1);
assert.equal(afterRecovery[3].attempts, 2);

const mediaPostResponse = await app.inject({ method: 'POST', url: '/api/posts', headers: { cookie }, payload: {
  projectId, title: 'Format sync', body: 'Body', scheduleMode: 'MANUAL'
} });
assert.equal(mediaPostResponse.statusCode, 201, mediaPostResponse.body);
const mediaPost = mediaPostResponse.json();
const image1 = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 30, b: 40 } } }).jpeg().toBuffer();
const image2 = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 80, g: 90, b: 100 } } }).jpeg().toBuffer();
const saved1 = await saveImageVersioned(mediaPost.id, 'one.jpg', image1, mediaPost.content_version);
assert.equal(db.prepare('SELECT content_format FROM posts WHERE id=?').get(mediaPost.id).content_format, 'IMAGE');
const saved2 = await saveImageVersioned(mediaPost.id, 'two.jpg', image2, saved1.contentVersion);
assert.equal(db.prepare('SELECT content_format FROM posts WHERE id=?').get(mediaPost.id).content_format, 'CAROUSEL');
await deleteMediaVersioned(saved2.media.id, saved2.contentVersion);
assert.equal(db.prepare('SELECT content_format FROM posts WHERE id=?').get(mediaPost.id).content_format, 'IMAGE');

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'M0-005',
  schemaVersion: 7,
  dstNonexistentRejected: true,
  dstAmbiguousRequiresChoice: true,
  queueToAtConfirmation: true,
  renditionInheritance: true,
  renditionVersionedAndSnapshotted: true,
  sequenceRecoveryNoDuplicate: true,
  failedUnitBlocksSequence: true,
  imageCarouselFormatSync: true
}, null, 2));

await app.close();
db.close();
await fs.rm(dataDir, { recursive: true, force: true });
