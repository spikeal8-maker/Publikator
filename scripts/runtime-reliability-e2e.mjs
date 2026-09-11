import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-runtime-reliability-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'runtime-reliability-test-password';
process.env.APP_MASTER_KEY = 'runtime-reliability-test-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';
process.env.QUEUE_SLOT_GRACE_MINUTES = '60';
process.env.EVENT_RETENTION_DAYS = '0';
process.env.BACKUP_RETENTION_COUNT = '0';

const { db, migrate, id } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { ensureTargets, setTargetSelection } = await import('../dist/publisher.js');
const { snapshotContentRevision, markReadyRevision } = await import('../dist/content-versioning.js');
const { setPublisherForTests } = await import('../dist/platforms/index.js');
const { telegramPublisher } = await import('../dist/platforms/telegram.js');
const { schedulerTick } = await import('../dist/scheduler.js');

migrate();

const accountId = id('acc');
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`)
  .run(
    accountId,
    'telegram',
    'Scheduler test Telegram',
    encryptJson({ botToken: 'test-bot-token', chatId: '@test-channel' }),
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );

const publishedPostIds = [];
setPublisherForTests('telegram', {
  platform: 'telegram',
  validate(input) {
    assert.ok(input.media.length >= 1);
  },
  async publish(input) {
    publishedPostIds.push(input.postId);
    return { externalId: `mock-${publishedPostIds.length}` };
  }
});

function createProject(name) {
  const projectId = id('prj');
  db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)')
    .run(projectId, name, projectId.replaceAll('_', '-'), '2026-01-01T00:00:00.000Z');
  return projectId;
}

function createPost(projectId, { mode = 'QUEUE', scheduledAt = null, createdAt = '2026-09-07T09:00:00.000Z' } = {}) {
  const postId = id('post');
  db.prepare(`INSERT INTO posts
    (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(postId, projectId, `Post ${postId}`, 'Runtime reliability body', 'READY', mode, scheduledAt, createdAt, createdAt);
  ensureTargets(postId);
  setTargetSelection(postId, [accountId]);
  db.prepare(`INSERT INTO media
    (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,0)`)
    .run(
      id('med'),
      postId,
      'test.jpg',
      `${postId}/test.jpg`,
      'image/jpeg',
      128,
      100,
      100,
      'a'.repeat(64),
      createdAt
    );
  const revision = snapshotContentRevision(postId, 1, 'runtime-reliability-test');
  markReadyRevision(postId, 1, revision.id);
  return postId;
}

function createSlot(projectId, weekday, time) {
  const slotId = id('slot');
  db.prepare(`INSERT INTO schedule_slots
    (id,project_id,weekday,time_hhmm,timezone,enabled,last_fired_on,created_at)
    VALUES (?,?,?,?,?,1,NULL,?)`)
    .run(slotId, projectId, weekday, time, 'UTC', '2026-01-01T00:00:00.000Z');
  return slotId;
}

function postStatus(postId) {
  return db.prepare('SELECT status FROM posts WHERE id=?').get(postId).status;
}

function slotState(slotId) {
  return db.prepare('SELECT last_fired_on FROM schedule_slots WHERE id=?').get(slotId).last_fired_on;
}

try {
  // A short restart/stall must not lose a queue slot: 20 minutes late is within the default 60-minute window.
  const catchupProject = createProject('Queue catch-up');
  const catchupPost = createPost(catchupProject);
  const catchupSlot = createSlot(catchupProject, 1, '10:00');
  await schedulerTick(new Date('2026-09-07T10:20:00.000Z'));
  assert.equal(postStatus(catchupPost), 'PUBLISHED');
  assert.equal(slotState(catchupSlot), '2026-09-07');
  assert.equal(publishedPostIds.filter((value) => value === catchupPost).length, 1);

  // An empty queue keeps the occurrence open during the grace window and can publish content that becomes READY later.
  const delayedContentProject = createProject('Queue content arrives later');
  const delayedContentSlot = createSlot(delayedContentProject, 1, '11:00');
  await schedulerTick(new Date('2026-09-07T11:10:00.000Z'));
  assert.equal(slotState(delayedContentSlot), null);
  const delayedContentPost = createPost(delayedContentProject, { createdAt: '2026-09-07T11:15:00.000Z' });
  await schedulerTick(new Date('2026-09-07T11:30:00.000Z'));
  assert.equal(postStatus(delayedContentPost), 'PUBLISHED');
  assert.equal(slotState(delayedContentSlot), '2026-09-07');
  assert.equal(publishedPostIds.filter((value) => value === delayedContentPost).length, 1);

  // After the grace window the slot is closed exactly once instead of publishing stale content later.
  const expiredProject = createProject('Queue expired');
  const expiredSlot = createSlot(expiredProject, 1, '12:00');
  await schedulerTick(new Date('2026-09-07T13:05:00.000Z'));
  assert.equal(slotState(expiredSlot), '2026-09-07');
  const missedEvents = Number(db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE event_type='queue_slot_missed'").get().count);
  assert.equal(missedEvents, 1);
  const stalePost = createPost(expiredProject, { createdAt: '2026-09-07T13:06:00.000Z' });
  await schedulerTick(new Date('2026-09-07T13:10:00.000Z'));
  assert.equal(postStatus(stalePost), 'READY');
  assert.equal(publishedPostIds.includes(stalePost), false);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE event_type='queue_slot_missed'").get().count), 1);

  // Grace windows that cross midnight retain the occurrence date of the original slot.
  const midnightProject = createProject('Queue cross midnight');
  const midnightPost = createPost(midnightProject, { createdAt: '2026-09-07T22:00:00.000Z' });
  const midnightSlot = createSlot(midnightProject, 1, '23:30');
  await schedulerTick(new Date('2026-09-08T00:10:00.000Z'));
  assert.equal(postStatus(midnightPost), 'PUBLISHED');
  assert.equal(slotState(midnightSlot), '2026-09-07');
  assert.equal(publishedPostIds.filter((value) => value === midnightPost).length, 1);

  // A due AT post that became impossible after READY must leave READY instead of generating an error every scheduler tick.
  const blockedProject = createProject('Blocked AT');
  const blockedAtPost = createPost(blockedProject, {
    mode: 'AT',
    scheduledAt: '2026-09-07T09:00:00.000Z',
    createdAt: '2026-09-07T08:00:00.000Z'
  });
  db.prepare('UPDATE social_accounts SET enabled=0 WHERE id=?').run(accountId);
  await schedulerTick(new Date('2026-09-07T14:00:00.000Z'));
  assert.equal(postStatus(blockedAtPost), 'FAILED');
  const blockedEventsAfterFirstTick = Number(db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE post_id=? AND event_type='scheduler_publish_blocked'").get(blockedAtPost).count);
  assert.equal(blockedEventsAfterFirstTick, 1);
  await schedulerTick(new Date('2026-09-07T14:01:00.000Z'));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE post_id=? AND event_type='scheduler_publish_blocked'").get(blockedAtPost).count), 1);
  db.prepare('UPDATE social_accounts SET enabled=1 WHERE id=?').run(accountId);

  // Telegram must reject content that cannot fit the follow-up sendMessage before any media POST starts.
  const telegramMedia = {
    id: 'telegram-media',
    post_id: 'telegram-post',
    original_name: 'telegram.jpg',
    relative_path: 'telegram-post/telegram.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 128,
    width: 100,
    height: 100,
    sha256: 'b'.repeat(64),
    created_at: '2026-09-10T00:00:00.000Z',
    sort_order: 0
  };
  const telegramBase = {
    postId: 'telegram-post',
    title: 'Telegram length',
    media: [telegramMedia],
    credentials: { botToken: 'test-token', chatId: '@test-channel' },
    publicMediaUrls: []
  };
  assert.doesNotThrow(() => telegramPublisher.validate({ ...telegramBase, text: '🙂'.repeat(4096) }));
  assert.throws(
    () => telegramPublisher.validate({ ...telegramBase, text: '🙂'.repeat(4097) }),
    /превышает предел 4096/
  );

  console.log(JSON.stringify({
    ok: true,
    queueGraceMinutes: 60,
    publishedPostIds,
    missedEvents,
    blockedAtPost,
    telegramUnicodeBoundaryChecked: true
  }, null, 2));
} finally {
  setPublisherForTests('telegram', null);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
