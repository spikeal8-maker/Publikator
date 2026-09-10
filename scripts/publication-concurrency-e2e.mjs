import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-concurrency-e2e-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'concurrency-ci-password';
process.env.APP_MASTER_KEY = 'concurrency-ci-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';
process.env.SCHEDULER_INTERVAL_MS = '15000';

const sharp = (await import('sharp')).default;
const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { saveImage } = await import('../dist/media.js');
const { ensureTargets, setTargetSelection, publishPost, publishTarget } = await import('../dist/publisher.js');
const { setPublisherForTests } = await import('../dist/platforms/index.js');

migrate();

let publishCalls = 0;
let currentGate = null;

function controlledGate() {
  let release;
  let enteredResolve;
  const wait = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  currentGate = { wait, release, entered, enteredResolve };
  return currentGate;
}

setPublisherForTests('telegram', {
  platform: 'telegram',
  validate(input) {
    assert.ok(input.media.length >= 1);
  },
  async publish(input) {
    publishCalls += 1;
    const gate = currentGate;
    assert.ok(gate, 'controlled gate must be configured before publish');
    gate.enteredResolve();
    await gate.wait;
    return {
      externalId: `concurrency-${publishCalls}`,
      externalUrl: `https://example.test/posts/${input.postId}/${publishCalls}`
    };
  }
});

const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
assert.ok(project?.id);

const accountId = id('acc');
const createdAt = nowIso();
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`)
  .run(accountId, 'telegram', 'Concurrency Telegram', encryptJson({ botToken: 'mock-token', chatId: '@mock' }), createdAt, createdAt);

const image = await sharp({
  create: {
    width: 32,
    height: 32,
    channels: 3,
    background: { r: 10, g: 20, b: 30 }
  }
}).jpeg().toBuffer();

async function createReadyPost(title) {
  const postId = id('post');
  const now = nowIso();
  db.prepare(`INSERT INTO posts
    (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(postId, project.id, title, 'Concurrency body', 'READY', 'MANUAL', null, now, now);
  ensureTargets(postId);
  setTargetSelection(postId, [accountId]);
  await saveImage(postId, 'image.jpg', image);
  return postId;
}

function targetFor(postId) {
  const target = db.prepare('SELECT * FROM post_targets WHERE post_id=? AND account_id=?').get(postId, accountId);
  assert.ok(target);
  return target;
}

try {
  // Two concurrent whole-post requests must produce exactly one external publish.
  {
    const postId = await createReadyPost('Concurrent publishPost');
    const before = publishCalls;
    const gate = controlledGate();

    const first = publishPost(postId);
    await gate.entered;

    const second = publishPost(postId);
    await second;

    assert.equal(publishCalls, before + 1, 'second publishPost must not call the external publisher while first owns the target');
    let target = targetFor(postId);
    assert.equal(target.state, 'PUBLISHING');
    assert.equal(target.attempts, 1, 'only the successful claim may increment attempts');

    gate.release();
    await first;

    target = targetFor(postId);
    assert.equal(target.state, 'PUBLISHED');
    assert.equal(target.attempts, 1);
    const started = db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE post_id=? AND event_type='publish_started'").get(postId);
    const succeeded = db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE post_id=? AND event_type='publish_succeeded'").get(postId);
    assert.equal(started.count, 1);
    assert.equal(succeeded.count, 1);
  }

  // A stale scheduler/direct target call racing an already-running target must also be harmless.
  {
    const postId = await createReadyPost('Concurrent publishTarget');
    const targetId = targetFor(postId).id;
    const before = publishCalls;
    const gate = controlledGate();

    const first = publishTarget(targetId);
    await gate.entered;

    const second = publishTarget(targetId);
    await second;

    assert.equal(publishCalls, before + 1, 'stale target invocation must fail the atomic claim before external POST');
    assert.equal(targetFor(postId).attempts, 1);

    gate.release();
    await first;

    const target = targetFor(postId);
    assert.equal(target.state, 'PUBLISHED');
    assert.equal(target.attempts, 1);
  }

  console.log(JSON.stringify({ ok: true, externalPublishCalls: publishCalls, scenarios: 2 }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
