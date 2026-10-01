import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-key-03a-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'key-03a-password';
process.env.APP_MASTER_KEY = 'key-03a-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { saveImage, mediaAbsolutePath } = await import('../dist/media.js');
const { ensureTargets, setTargetSelection, publishPost } = await import('../dist/publisher.js');
const { snapshotContentRevision, markReadyRevision } = await import('../dist/content-versioning.js');
const { getPublisher } = await import('../dist/platforms/index.js');
const { vkPublisher } = await import('../dist/platforms/vk.js');

migrate();

const originalFetch = globalThis.fetch;
const vkCalls = [];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function apiMethod(url) {
  return /\/method\/([^/?]+)/.exec(String(url))?.[1] || null;
}

try {
  assert.strictEqual(
    getPublisher('vk'),
    vkPublisher,
    'KEY-03A must exercise the registered real vkPublisher, not a test override'
  );

  const now = nowIso();
  const projectId = id('prj');
  db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)')
    .run(projectId, 'KEY-03A Project', 'key-03a-project', now);

  const accountId = id('acc');
  const credentials = {
    accessToken: 'key-03a-user-token',
    authKind: 'USER',
    destinationKind: 'COMMUNITY',
    groupId: '67890',
    destinationName: 'KEY-03A Community',
    apiVersion: '5.199'
  };
  db.prepare(
    'INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) ' +
    'VALUES (?,?,?,?,1,?,?)'
  ).run(
    accountId,
    'vk',
    'KEY-03A VK',
    encryptJson(credentials),
    now,
    now
  );

  const postId = id('post');
  db.prepare(
    'INSERT INTO posts (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    postId,
    projectId,
    'KEY-03A real publisher',
    'KEY-03A body',
    'DRAFT',
    'MANUAL',
    null,
    now,
    now
  );

  ensureTargets(postId);
  setTargetSelection(postId, [accountId]);

  const sourceJpeg = await sharp({
    create: {
      width: 24,
      height: 24,
      channels: 3,
      background: { r: 40, g: 80, b: 120 }
    }
  }).jpeg().toBuffer();

  const savedMedia = await saveImage(postId, 'key-03a.jpg', sourceJpeg);
  const expectedUploadedBytes = await fs.readFile(mediaAbsolutePath(savedMedia));
  assert.ok(expectedUploadedBytes.byteLength > 0);

  const revision = snapshotContentRevision(postId, 1, 'manual');
  markReadyRevision(postId, 1, revision.id);

  const readyPost = db.prepare(
    'SELECT status,editorial_stage,content_version,ready_revision_id FROM posts WHERE id=?'
  ).get(postId);
  assert.equal(readyPost.status, 'READY');
  assert.equal(readyPost.editorial_stage, 'APPROVED');
  assert.equal(readyPost.content_version, 1);
  assert.equal(readyPost.ready_revision_id, revision.id);

  const targetBefore = db.prepare(
    'SELECT id,state,attempts,enabled FROM post_targets WHERE post_id=? AND account_id=?'
  ).get(postId, accountId);
  assert.ok(targetBefore);
  assert.equal(targetBefore.enabled, 1);
  assert.equal(targetBefore.state, 'PENDING');
  assert.equal(targetBefore.attempts, 0);

  const expectedSteps = [
    'photos.getWallUploadServer',
    'upload',
    'photos.saveWallPhoto',
    'wall.post'
  ];

  globalThis.fetch = async (request, init = {}) => {
    const url = String(request);
    const method = String(init.method || 'GET').toUpperCase();
    const vkMethod = apiMethod(url);
    const body = init.body instanceof URLSearchParams
      ? Object.fromEntries(init.body.entries())
      : null;
    const form = init.body instanceof FormData ? init.body : null;

    const phase = vkMethod || 'upload';
    vkCalls.push({ phase, url, method, body, form, init });
    assert.equal(
      phase,
      expectedSteps[vkCalls.length - 1],
      'unexpected VK call order at step ' + vkCalls.length
    );

    if (vkMethod === 'photos.getWallUploadServer') {
      assert.equal(method, 'POST');
      assert.equal(body.access_token, 'key-03a-user-token');
      assert.equal(body.v, '5.199');
      assert.equal(body.group_id, '67890');
      return json({ response: { upload_url: 'https://upload.vk.test/key-03a-wall' } });
    }

    if (!vkMethod) {
      assert.equal(url, 'https://upload.vk.test/key-03a-wall');
      assert.equal(method, 'POST');
      assert.ok(form instanceof FormData);
      const photo = form.get('photo');
      assert.ok(photo instanceof Blob, 'wall upload must use multipart photo field');
      assert.equal(form.get('file1'), null, 'existing WALL path must not use album file1 field');
      const actualBytes = Buffer.from(await photo.arrayBuffer());
      assert.deepEqual(actualBytes, expectedUploadedBytes, 'publisher must upload the actual stored JPEG bytes');
      return json({ server: 42, photo: '[{"photo":"fixture"}]', hash: 'hash-key-03a' });
    }

    if (vkMethod === 'photos.saveWallPhoto') {
      assert.equal(method, 'POST');
      assert.equal(body.access_token, 'key-03a-user-token');
      assert.equal(body.v, '5.199');
      assert.equal(body.group_id, '67890');
      assert.equal(body.user_id, undefined);
      assert.equal(body.server, '42');
      assert.equal(body.photo, '[{"photo":"fixture"}]');
      assert.equal(body.hash, 'hash-key-03a');
      return json({ response: [{ owner_id: -67890, id: 777 }] });
    }

    if (vkMethod === 'wall.post') {
      assert.equal(method, 'POST');
      assert.equal(body.access_token, 'key-03a-user-token');
      assert.equal(body.v, '5.199');
      assert.equal(body.owner_id, '-67890');
      assert.equal(body.from_group, '1');
      assert.equal(body.message, 'KEY-03A body');
      assert.equal(body.attachments, 'photo-67890_777');
      assert.equal(body.guid, postId + ':-67890');
      return json({ response: { post_id: 9001 } });
    }

    throw new Error('unexpected VK request ' + method + ' ' + url);
  };

  await publishPost(postId);

  assert.deepEqual(
    vkCalls.map((call) => call.phase),
    expectedSteps,
    'full product path must use the real WALL image publisher sequence exactly once'
  );
  assert.equal(vkCalls.filter((call) => call.phase === 'wall.post').length, 1);

  const targetAfter = db.prepare(
    'SELECT state,attempts,external_id,external_url,published_at,last_error FROM post_targets WHERE id=?'
  ).get(targetBefore.id);
  assert.equal(targetAfter.state, 'PUBLISHED');
  assert.equal(targetAfter.attempts, 1);
  assert.equal(targetAfter.external_id, '9001');
  assert.equal(targetAfter.external_url, 'https://vk.com/wall-67890_9001');
  assert.ok(targetAfter.published_at);
  assert.equal(targetAfter.last_error, null);

  const postAfter = db.prepare(
    'SELECT status,editorial_stage,content_version,ready_revision_id FROM posts WHERE id=?'
  ).get(postId);
  assert.equal(postAfter.status, 'PUBLISHED');
  assert.equal(postAfter.editorial_stage, 'APPROVED');
  assert.equal(postAfter.content_version, 1);
  assert.equal(postAfter.ready_revision_id, revision.id);

  const persistedRevision = db.prepare(
    'SELECT id,post_id,content_version,editorial_stage FROM content_revisions WHERE id=?'
  ).get(revision.id);
  assert.equal(persistedRevision.id, revision.id);
  assert.equal(persistedRevision.post_id, postId);
  assert.equal(persistedRevision.content_version, 1);
  assert.equal(persistedRevision.editorial_stage, 'APPROVED');

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'KEY-03A',
    realPublisherRegistered: true,
    readyRevision: true,
    publishPostPath: true,
    vkHttpMockOnly: true,
    sequence: expectedSteps,
    multipartField: 'photo',
    actualStoredJpegBytesUploaded: true,
    targetState: targetAfter.state,
    postStatus: postAfter.status,
    wallPostCalls: 1,
    realPublications: 0
  }));
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
