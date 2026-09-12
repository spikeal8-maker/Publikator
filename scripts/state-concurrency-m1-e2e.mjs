import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-m0-002-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'm0-002-ci-password';
process.env.APP_MASTER_KEY = 'm0-002-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const sharp = (await import('sharp')).default;
const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { saveImage, saveImageVersioned } = await import('../dist/media.js');
const { publishPost } = await import('../dist/publisher.js');
const { setPublisherForTests } = await import('../dist/platforms/index.js');
const { buildApp } = await import('../dist/app.js');

migrate();
assert.equal(Number(db.pragma('user_version', { simple: true })), 6);

let publishCalls = 0;
let publishedTexts = [];
let gate = null;
setPublisherForTests('telegram', {
  platform: 'telegram',
  validate(input) { assert.ok(input.media.length >= 1); },
  async publish(input) {
    publishCalls += 1;
    publishedTexts.push(input.text);
    if (gate) { gate.entered(); await gate.wait; }
    return { externalId: `m0-002-${publishCalls}` };
  }
});
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const accountId = id('acc');
const now = nowIso();
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`)
  .run(accountId, 'telegram', 'M0-002 Telegram', encryptJson({ botToken: 'mock', chatId: '@mock' }), now, now);

const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 80, g: 90, b: 100 } } }).jpeg().toBuffer();
const app = await buildApp();
await app.ready();

const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];

async function api(method, url, payload, expected = 200, headers = {}) {
  const response = await app.inject({ method, url, headers: { cookie, ...headers }, payload });
  assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
  return response.json();
}

async function createDraft(title, body) {
  return api('POST', '/api/posts', { projectId, title, body, scheduleMode: 'MANUAL' }, 201);
}

async function attachAndReady(post) {
  await saveImage(post.id, `${post.id}.jpg`, image);
  let current = (await api('GET', `/api/posts/${post.id}`));
  current = await api('PUT', `/api/posts/${post.id}/targets`, { accountIds: [accountId], expectedContentVersion: current.content_version });
  const afterTargets = await api('GET', `/api/posts/${post.id}`);
  await api('POST', `/api/posts/${post.id}/ready`, { expectedContentVersion: afterTargets.content_version });
  return api('GET', `/api/posts/${post.id}`);
}
try {
  // Stale editorial writes must fail instead of last-write-wins.
  const stalePost = await createDraft('Stale base', 'Original body');
  assert.equal(stalePost.content_version, 1);
  const firstEdit = await api('PATCH', `/api/posts/${stalePost.id}`, {
    title: 'First writer wins',
    expectedContentVersion: 1
  });
  assert.equal(firstEdit.contentVersion, 2);
  const staleEdit = await api('PATCH', `/api/posts/${stalePost.id}`, {
    body: 'Stale overwrite',
    expectedContentVersion: 1
  }, 409);
  assert.match(staleEdit.error, /Версия|устар/i);
  const afterConflict = await api('GET', `/api/posts/${stalePost.id}`);
  assert.equal(afterConflict.title, 'First writer wins');
  assert.equal(afterConflict.body, 'Original body');
  assert.equal(afterConflict.content_version, 2);

  // Stale asynchronous media work must not create media or advance the content version.
  const staleMediaPost = await createDraft('Stale media', 'Media body');
  await api('PATCH', `/api/posts/${staleMediaPost.id}`, {
    title: 'Version advanced',
    expectedContentVersion: 1
  });
  await assert.rejects(
    () => saveImageVersioned(staleMediaPost.id, 'stale.jpg', image, 1),
    /Версия/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media WHERE post_id=?').get(staleMediaPost.id).count, 0);
  assert.equal(db.prepare('SELECT content_version FROM posts WHERE id=?').get(staleMediaPost.id).content_version, 2);

  // Editing READY content invalidates the approved revision and requires new preflight.
  const readyForEdit = await attachAndReady(await createDraft('Ready edit', 'Ready body'));
  assert.equal(readyForEdit.status, 'READY');
  assert.ok(readyForEdit.ready_revision_id);
  const readyVersion = readyForEdit.content_version;
  const changedReady = await api('PATCH', `/api/posts/${readyForEdit.id}`, {
    body: 'Changed after READY',
    expectedContentVersion: readyVersion
  });
  assert.equal(changedReady.contentVersion, readyVersion + 1);
  const invalidated = await api('GET', `/api/posts/${readyForEdit.id}`);
  assert.equal(invalidated.status, 'DRAFT');
  assert.equal(invalidated.editorial_stage, 'DRAFT');
  assert.equal(invalidated.ready_revision_id, null);
  await assert.rejects(() => publishPost(readyForEdit.id), /READY|revision/);

  // Publisher must use the immutable revision, not mutable working columns.
  const snapshotPost = await attachAndReady(await createDraft('Snapshot', 'Immutable snapshot body'));
  db.prepare("UPDATE posts SET body='CORRUPTED LIVE BODY' WHERE id=?").run(snapshotPost.id);
  const beforeSnapshotPublish = publishCalls;
  await publishPost(snapshotPost.id);
  assert.equal(publishCalls, beforeSnapshotPublish + 1);
  assert.equal(publishedTexts.at(-1), 'Immutable snapshot body');

  // Once publication claims the approved revision, editing is blocked until outcome is known.
  const racingPost = await attachAndReady(await createDraft('Publish race', 'Race snapshot body'));
  let releaseGate;
  let enteredGate;
  const entered = new Promise((resolve) => { enteredGate = resolve; });
  const wait = new Promise((resolve) => { releaseGate = resolve; });
  gate = { wait, entered: enteredGate };
  const publishing = publishPost(racingPost.id);
  await entered;
  const duringPublish = await api('GET', `/api/posts/${racingPost.id}`);
  assert.equal(duringPublish.status, 'PUBLISHING');
  const blockedEdit = await api('PATCH', `/api/posts/${racingPost.id}`, {
    body: 'Must not replace in-flight snapshot',
    expectedContentVersion: duringPublish.content_version
  }, 409);
  assert.match(blockedEdit.error, /после начала публикации|редактировать/i);
  releaseGate();
  await publishing;
  gate = null;
  assert.equal(publishedTexts.at(-1), 'Race snapshot body');

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'M0-002',
    schemaVersion: 6,
    staleEditConflict: true,
    readyInvalidation: true,
    immutableSnapshotPublish: true,
    editDuringPublishBlocked: true,
    publishCalls
  }, null, 2));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
