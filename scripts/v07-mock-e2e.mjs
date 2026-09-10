import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-v07-e2e-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'v07-ci-password';
process.env.APP_MASTER_KEY = 'v07-ci-master-key-that-is-definitely-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';
process.env.SCHEDULER_INTERVAL_MS = '15000';
process.env.EVENT_RETENTION_DAYS = '1';
process.env.BACKUP_RETENTION_COUNT = '2';

const sharp = (await import('sharp')).default;
const { db, migrate, id, nowIso, event } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { saveImage } = await import('../dist/media.js');
const {
  ensureTargets,
  setTargetSelection,
  publishPost,
  retryFailedTarget,
  confirmRecoveryNotPublished,
  confirmRecoveryPublished
} = await import('../dist/publisher.js');
const { PlatformError } = await import('../dist/platforms/types.js');
const { setPublisherForTests } = await import('../dist/platforms/index.js');
const { schedulerTick, schedulerStatus } = await import('../dist/scheduler.js');
const { retentionStatus } = await import('../dist/retention.js');
const { collectDiagnostics } = await import('../dist/diagnostics.js');

migrate();

let publishMode = 'success';
let publishCalls = 0;
const publishedInputs = [];
const mockPublisher = {
  platform: 'telegram',
  validate(input) {
    assert.ok(Array.isArray(input.media) && input.media.length >= 1, 'mock requires media');
    assert.equal(typeof input.text, 'string');
  },
  async publish(input) {
    publishCalls += 1;
    publishedInputs.push({ postId: input.postId, text: input.text, mediaCount: input.media.length });
    if (publishMode === 'unknown') {
      throw new PlatformError('Mock network outcome unknown', { outcomeUnknown: true });
    }
    if (publishMode === 'retryable') {
      throw new PlatformError('Mock rate limit', { retryable: true, status: 429 });
    }
    return {
      externalId: `mock-${publishCalls}`,
      externalUrl: `https://example.test/posts/${publishCalls}`
    };
  }
};
setPublisherForTests('telegram', mockPublisher);

const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
assert.ok(project?.id, 'default project must exist after migrate');

const accountId = id('acc');
const accountCreatedAt = nowIso();
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`)
  .run(
    accountId,
    'telegram',
    'V0.7 Mock Telegram',
    encryptJson({ botToken: 'mock-token', chatId: '@mock' }),
    accountCreatedAt,
    accountCreatedAt
  );

const image = await sharp({
  create: {
    width: 64,
    height: 48,
    channels: 3,
    background: { r: 40, g: 120, b: 200 }
  }
}).png().toBuffer();

async function createPost({ title, body = 'Mock body', scheduleMode = 'MANUAL', scheduledAt = null, status = 'READY' }) {
  const postId = id('post');
  const now = nowIso();
  db.prepare(`INSERT INTO posts
    (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(postId, project.id, title, body, status, scheduleMode, scheduledAt, now, now);
  ensureTargets(postId);
  setTargetSelection(postId, [accountId]);
  await saveImage(postId, `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'image'}.png`, image);
  return postId;
}

function targetFor(postId) {
  const target = db.prepare(`SELECT pt.*,a.platform,a.name AS account_name
    FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.post_id=? AND pt.account_id=?`).get(postId, accountId);
  assert.ok(target, `target must exist for ${postId}`);
  return target;
}

function postStatus(postId) {
  return db.prepare('SELECT status FROM posts WHERE id=?').get(postId)?.status;
}

async function seedRetentionBackups() {
  const backupDir = path.join(dataDir, 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const now = Date.now();
  const files = [
    ['publikator-2026-01-01T00-00-00-000Z-manual.tgz', now - 4 * 86_400_000],
    ['publikator-2026-01-02T00-00-00-000Z-pre-restore.tgz', now - 3 * 86_400_000],
    ['publikator-2026-01-03T00-00-00-000Z-manual.tgz', now - 2 * 86_400_000],
    ['publikator-2026-01-04T00-00-00-000Z-manual.tgz', now - 1 * 86_400_000]
  ];
  for (const [name, mtimeMs] of files) {
    const filePath = path.join(backupDir, name);
    await fs.writeFile(filePath, `fixture:${name}`, 'utf8');
    const timestamp = new Date(mtimeMs);
    await fs.utimes(filePath, timestamp, timestamp);
  }
  return backupDir;
}

try {
  const successPostId = await createPost({ title: 'Publisher success' });
  publishMode = 'success';
  const callsBeforeSuccess = publishCalls;
  await publishPost(successPostId);
  const successTarget = targetFor(successPostId);
  assert.equal(successTarget.state, 'PUBLISHED');
  assert.equal(postStatus(successPostId), 'PUBLISHED');
  assert.equal(publishCalls, callsBeforeSuccess + 1);
  assert.match(String(successTarget.external_id), /^mock-/);

  const recoveryRetryPostId = await createPost({ title: 'Recovery then retry' });
  publishMode = 'unknown';
  const callsBeforeUnknown = publishCalls;
  await publishPost(recoveryRetryPostId);
  let recoveryRetryTarget = targetFor(recoveryRetryPostId);
  assert.equal(recoveryRetryTarget.state, 'RECOVERY_NEEDED');
  assert.equal(postStatus(recoveryRetryPostId), 'PARTIAL');
  assert.equal(publishCalls, callsBeforeUnknown + 1);
  assert.match(String(recoveryRetryTarget.last_error), /автоматический повтор отключён/);

  const callsBeforeBlockedRetry = publishCalls;
  await assert.rejects(
    () => retryFailedTarget(recoveryRetryTarget.id),
    /сначала вручную проверьте площадку/i
  );
  assert.equal(publishCalls, callsBeforeBlockedRetry, 'RECOVERY_NEEDED must not publish through generic retry');
  assert.equal(targetFor(recoveryRetryPostId).state, 'RECOVERY_NEEDED');

  confirmRecoveryNotPublished(recoveryRetryTarget.id);
  recoveryRetryTarget = targetFor(recoveryRetryPostId);
  assert.equal(recoveryRetryTarget.state, 'FAILED');
  assert.equal(postStatus(recoveryRetryPostId), 'FAILED');
  assert.match(String(recoveryRetryTarget.last_error), /повтор снова разрешён/i);

  publishMode = 'success';
  const callsBeforeResolvedRetry = publishCalls;
  await retryFailedTarget(recoveryRetryTarget.id);
  recoveryRetryTarget = targetFor(recoveryRetryPostId);
  assert.equal(recoveryRetryTarget.state, 'PUBLISHED');
  assert.equal(postStatus(recoveryRetryPostId), 'PUBLISHED');
  assert.equal(publishCalls, callsBeforeResolvedRetry + 1);

  const manualPublishedPostId = await createPost({ title: 'Recovery confirmed published' });
  publishMode = 'unknown';
  await publishPost(manualPublishedPostId);
  let manualPublishedTarget = targetFor(manualPublishedPostId);
  assert.equal(manualPublishedTarget.state, 'RECOVERY_NEEDED');
  const callsBeforeManualPublished = publishCalls;
  confirmRecoveryPublished(
    manualPublishedTarget.id,
    'manual-external-id',
    'https://example.test/posts/manual-external-id'
  );
  manualPublishedTarget = targetFor(manualPublishedPostId);
  assert.equal(manualPublishedTarget.state, 'PUBLISHED');
  assert.equal(manualPublishedTarget.external_id, 'manual-external-id');
  assert.equal(manualPublishedTarget.external_url, 'https://example.test/posts/manual-external-id');
  assert.equal(postStatus(manualPublishedPostId), 'PUBLISHED');
  assert.equal(publishCalls, callsBeforeManualPublished, 'confirm-published must never call external publisher');
  const manualEvent = db.prepare(`SELECT event_type FROM publication_events
    WHERE post_id=? AND event_type='publish_recovery_confirmed_published'
    ORDER BY created_at DESC LIMIT 1`).get(manualPublishedPostId);
  assert.equal(manualEvent?.event_type, 'publish_recovery_confirmed_published');

  event({ type: 'old-prunable-event', message: 'This old event should be removed by retention' });
  db.prepare("UPDATE publication_events SET created_at=? WHERE event_type='old-prunable-event'")
    .run(new Date(Date.now() - 3 * 86_400_000).toISOString());

  const protectedRecoveryPostId = await createPost({ title: 'Protected recovery history', status: 'PARTIAL' });
  const protectedRecoveryTarget = targetFor(protectedRecoveryPostId);
  db.prepare("UPDATE post_targets SET state='RECOVERY_NEEDED',last_error='Protected old recovery',updated_at=? WHERE id=?")
    .run(nowIso(), protectedRecoveryTarget.id);
  event({
    postId: protectedRecoveryPostId,
    accountId,
    level: 'error',
    type: 'old-protected-recovery-event',
    message: 'This old recovery history must survive retention'
  });
  db.prepare("UPDATE publication_events SET created_at=? WHERE event_type='old-protected-recovery-event'")
    .run(new Date(Date.now() - 3 * 86_400_000).toISOString());

  const backupDir = await seedRetentionBackups();

  const schedulerPostId = await createPost({
    title: 'Scheduler AT success',
    scheduleMode: 'AT',
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    status: 'READY'
  });
  publishMode = 'success';
  const callsBeforeScheduler = publishCalls;
  await schedulerTick();
  assert.equal(postStatus(schedulerPostId), 'PUBLISHED');
  assert.equal(targetFor(schedulerPostId).state, 'PUBLISHED');
  assert.equal(publishCalls, callsBeforeScheduler + 1);
  const scheduler = schedulerStatus();
  assert.equal(scheduler.running, false);
  assert.ok(scheduler.lastStartedAt);
  assert.ok(scheduler.lastCompletedAt);
  assert.ok(Number.isInteger(scheduler.lastDurationMs) && scheduler.lastDurationMs >= 0);
  assert.ok(scheduler.lastWork.duePosts >= 1);
  assert.equal(scheduler.lastError, null);

  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE event_type='old-prunable-event'").get().count,
    0,
    'old unrelated event must be pruned'
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE event_type='old-protected-recovery-event'").get().count,
    1,
    'active recovery history must be protected from retention'
  );
  const retention = retentionStatus();
  assert.equal(retention.eventRetentionDays, 1);
  assert.equal(retention.backupRetentionCount, 2);
  assert.equal(retention.lastDeletedEvents, 1);
  assert.deepEqual(retention.lastDeletedBackups, ['publikator-2026-01-01T00-00-00-000Z-manual.tgz']);
  const remainingBackups = (await fs.readdir(backupDir)).filter((name) => name.endsWith('.tgz')).sort();
  assert.deepEqual(remainingBackups, [
    'publikator-2026-01-02T00-00-00-000Z-pre-restore.tgz',
    'publikator-2026-01-03T00-00-00-000Z-manual.tgz',
    'publikator-2026-01-04T00-00-00-000Z-manual.tgz'
  ]);

  const callsBeforeProtectedResolution = publishCalls;
  confirmRecoveryPublished(
    protectedRecoveryTarget.id,
    'protected-manual-id',
    'https://example.test/posts/protected-manual-id'
  );
  assert.equal(publishCalls, callsBeforeProtectedResolution);
  assert.equal(targetFor(protectedRecoveryPostId).state, 'PUBLISHED');

  const diagnostics = await collectDiagnostics();
  assert.equal(diagnostics.database.quickCheck.toLowerCase(), 'ok');
  assert.equal(diagnostics.database.journalMode.toLowerCase(), 'wal');
  assert.equal(diagnostics.media.missingFiles, 0);
  assert.equal(diagnostics.media.sizeMismatches, 0);
  assert.equal(diagnostics.recovery.pendingTargets, 0);
  assert.equal(diagnostics.publicMedia.ready, true);
  assert.equal(diagnostics.publicMedia.https, true);
  assert.ok(diagnostics.scheduler.lastCompletedAt);
  assert.equal(diagnostics.retention.eventRetentionDays, 1);
  assert.equal(diagnostics.retention.backupRetentionCount, 2);
  assert.equal(diagnostics.retention.lastDeletedEvents, 1);

  const absentEventCount = db.prepare(`SELECT COUNT(*) AS count FROM publication_events
    WHERE event_type='publish_recovery_confirmed_absent'`).get().count;
  assert.equal(absentEventCount, 1);

  console.log(JSON.stringify({
    ok: true,
    publishCalls,
    publishedInputs,
    scheduler: schedulerStatus(),
    retention: retentionStatus(),
    diagnosticsSeverity: diagnostics.severity,
    counts: diagnostics.database.counts
  }, null, 2));
} finally {
  setPublisherForTests('telegram', null);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
