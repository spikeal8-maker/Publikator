import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-010c-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cx3-010c-password';
process.env.APP_MASTER_KEY = 'cx3-010c-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
const { saveImageVersioned } = await import('../dist/media.js');
const delivery = await import('../dist/delivery-foundation.js');
const versioning = await import('../dist/content-versioning.js');
const publisher = await import('../dist/publisher.js');
const { PLATFORM_CAPABILITIES } = await import('../dist/platforms/capabilities.js');
const sharp = (await import('sharp')).default;

migrate();
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const accountId = id('acc');
const now = nowIso();
db.prepare(`INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`).run(accountId, 'telegram', 'Sequence Telegram', encryptJson({ botToken: 'mock-token', businessConnectionId: 'business-1' }), now, now);

const app = await buildApp();
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];
const created = await app.inject({ method: 'POST', url: '/api/posts', headers: { cookie }, payload: { projectId, title: 'Story sequence', body: 'Sequence caption', scheduleMode: 'MANUAL' } });
assert.equal(created.statusCode, 201, created.body);
let post = created.json();
const target = db.prepare('SELECT id FROM post_targets WHERE post_id=? AND account_id=?').get(post.id, accountId);
assert.ok(target?.id);

for (let index = 0; index < 3; index += 1) {
  const bytes = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: 20 + index * 20, g: 40, b: 60 } } }).jpeg({ quality: 70 }).toBuffer();
  const saved = await saveImageVersioned(post.id, `story-${index + 1}.jpg`, bytes, post.content_version);
  post.content_version = saved.contentVersion;
}
const rendition = delivery.saveTargetRendition(target.id, { publicationKind: 'STORY', contentFormat: 'STORY_SEQUENCE' }, post.content_version);
post.content_version = rendition.contentVersion;

const capability = PLATFORM_CAPABILITIES.telegram;
const savedCapability = structuredClone(capability);
capability.supportsStories = true;
capability.supportsStorySequence = true;
capability.allowedMimeTypes = ['image/jpeg', 'video/mp4'];

const revision = versioning.snapshotContentRevision(post.id, post.content_version, 'cx3-010c-test');
const preflight = publisher.preflightRevision(revision.id);
assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
versioning.markReadyRevision(post.id, post.content_version, revision.id);

let externalCalls = 0;
const captions = [];
globalThis.fetch = async (_url, init) => {
  externalCalls += 1;
  const form = init?.body;
  captions.push(form instanceof FormData ? form.get('caption') : null);
  if (externalCalls === 2) throw new TypeError('simulated network reset');
  const idValue = externalCalls === 1 ? 101 : externalCalls === 3 ? 102 : 103;
  return new Response(JSON.stringify({ ok: true, result: { id: idValue } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

await publisher.publishPost(post.id);
let units = delivery.listPublicationUnits(target.id);
assert.deepEqual(units.map((unit) => unit.state), ['PUBLISHED', 'RECOVERY_NEEDED', 'PENDING']);
assert.deepEqual(units.map((unit) => unit.attempts), [1, 1, 0]);
assert.equal(units[0].external_id, '101');
assert.equal(externalCalls, 2);
assert.equal(captions[0], 'Sequence caption');
assert.equal(captions[1], null);
assert.equal(db.prepare('SELECT state FROM post_targets WHERE id=?').get(target.id).state, 'RECOVERY_NEEDED');
assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(post.id).status, 'PARTIAL');

const genericRetry = await app.inject({ method: 'POST', url: `/api/targets/${target.id}/retry`, headers: { cookie } });
assert.equal(genericRetry.statusCode, 409, genericRetry.body);
assert.match(genericRetry.json().error, /multi-unit|PublicationUnit/i);

const listed = await app.inject({ method: 'GET', url: `/api/targets/${target.id}/publication-units`, headers: { cookie } });
assert.equal(listed.statusCode, 200, listed.body);
assert.equal(listed.json().units.length, 3);

const missingExternalId = await app.inject({
  method: 'POST',
  url: `/api/publication-units/${units[1].id}/recovery/confirm-published`,
  headers: { cookie },
  payload: {}
});
assert.equal(missingExternalId.statusCode, 400, missingExternalId.body);
assert.match(missingExternalId.json().error, /externalId/i);
assert.equal(delivery.listPublicationUnits(target.id)[1].state, 'RECOVERY_NEEDED');

const archived = await app.inject({
  method: 'POST',
  url: `/api/posts/${post.id}/archive`,
  headers: { cookie },
  payload: { expectedContentVersion: post.content_version }
});
assert.equal(archived.statusCode, 200, archived.body);
assert.equal(archived.json().post.editorial_stage, 'ARCHIVED');
assert.equal(archived.json().post.status, 'PARTIAL');
const callsBeforeArchivedContinue = externalCalls;
const archivedContinue = await app.inject({ method: 'POST', url: `/api/targets/${target.id}/sequence/continue`, headers: { cookie } });
assert.equal(archivedContinue.statusCode, 409, archivedContinue.body);
assert.match(archivedContinue.json().error, /APPROVED/i);
assert.equal(externalCalls, callsBeforeArchivedContinue, 'archived sequence must not perform an external POST');
const restored = await app.inject({
  method: 'POST',
  url: `/api/posts/${post.id}/restore`,
  headers: { cookie },
  payload: { expectedContentVersion: post.content_version }
});
assert.equal(restored.statusCode, 200, restored.body);
assert.equal(restored.json().post.editorial_stage, 'APPROVED');
assert.equal(restored.json().post.status, 'PARTIAL');

const confirmAbsent = await app.inject({ method: 'POST', url: `/api/publication-units/${units[1].id}/recovery/confirm-not-published`, headers: { cookie } });
assert.equal(confirmAbsent.statusCode, 200, confirmAbsent.body);
units = delivery.listPublicationUnits(target.id);
assert.deepEqual(units.map((unit) => unit.state), ['PUBLISHED', 'RETRY', 'PENDING']);

const continued = await app.inject({ method: 'POST', url: `/api/targets/${target.id}/sequence/continue`, headers: { cookie } });
assert.equal(continued.statusCode, 200, continued.body);
units = delivery.listPublicationUnits(target.id);
assert.deepEqual(units.map((unit) => unit.state), ['PUBLISHED', 'PUBLISHED', 'PUBLISHED']);
assert.deepEqual(units.map((unit) => unit.attempts), [1, 2, 1]);
assert.deepEqual(units.map((unit) => unit.external_id), ['101', '102', '103']);
assert.equal(externalCalls, 4, 'published slide #1 must not be sent again during resume');
assert.equal(db.prepare('SELECT state FROM post_targets WHERE id=?').get(target.id).state, 'PUBLISHED');
assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(post.id).status, 'PUBLISHED');

Object.assign(capability, savedCapability);
console.log(JSON.stringify({ ok: true, checkpoint: 'CX3-010C', publicationUnits: 3, unknownOutcomeScopedToUnit: true, resumeWithoutDuplicate: true, targetLevelRetryBlocked: true, truthfulManualRecoveryMetadata: true, archivedContinuationBlocked: true, finalAttempts: units.map((unit) => unit.attempts) }, null, 2));

await app.close();
db.close();
await fs.rm(dataDir, { recursive: true, force: true });
