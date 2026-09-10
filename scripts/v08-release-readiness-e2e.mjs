import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-v08-readiness-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'v08-readiness-password';
process.env.APP_MASTER_KEY = 'v08-readiness-master-key-that-is-definitely-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';
process.env.EVENT_RETENTION_DAYS = '0';
process.env.BACKUP_RETENTION_COUNT = '0';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { createBackupBundle } = await import('../dist/backups.js');
const { collectReleaseReadiness } = await import('../dist/release-readiness.js');

migrate();

function statusOf(report, idValue) {
  return report.checks.find((item) => item.id === idValue)?.status;
}

try {
  const withoutBackup = await collectReleaseReadiness();
  assert.equal(withoutBackup.releaseCandidate, '0.8.0-rc.1');
  assert.equal(withoutBackup.automatedReady, false);
  assert.equal(withoutBackup.stableV1Ready, false);
  assert.equal(statusOf(withoutBackup, 'full_backup'), 'block');
  assert.equal(statusOf(withoutBackup, 'live_platform_acceptance'), 'external_required');
  assert.deepEqual(withoutBackup.liveAcceptance.requiredPlatforms, ['telegram', 'vk', 'max', 'instagram']);

  const bundle = await createBackupBundle('v08-readiness');
  assert.match(bundle.name, /v08-readiness\.tgz$/);
  assert.ok(bundle.sizeBytes > 0);

  const ready = await collectReleaseReadiness();
  assert.equal(ready.automatedReady, true, JSON.stringify(ready.automatedBlockers));
  assert.equal(ready.stableV1Ready, false);
  assert.equal(statusOf(ready, 'full_backup'), 'pass');
  assert.equal(statusOf(ready, 'sqlite_integrity'), 'pass');
  assert.equal(statusOf(ready, 'sqlite_wal'), 'pass');
  assert.equal(statusOf(ready, 'media_consistency'), 'pass');
  assert.equal(statusOf(ready, 'recovery_queue'), 'pass');
  assert.equal(statusOf(ready, 'public_media_url'), 'pass');
  assert.equal(statusOf(ready, 'live_platform_acceptance'), 'external_required');

  const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
  assert.ok(project?.id);
  const accountId = id('acc');
  const postId = id('post');
  const targetId = id('pt');
  const now = nowIso();
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`).run(
      accountId,
      'telegram',
      'V0.8 readiness account',
      encryptJson({ botToken: 'fake', chatId: '@fake' }),
      now,
      now
    );
  db.prepare(`INSERT INTO posts
    (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
      postId,
      project.id,
      'V0.8 recovery blocker',
      'Must block RC readiness',
      'PARTIAL',
      'MANUAL',
      null,
      now,
      now
    );
  db.prepare(`INSERT INTO post_targets
    (id,post_id,account_id,enabled,state,attempts,last_error,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      targetId,
      postId,
      accountId,
      1,
      'RECOVERY_NEEDED',
      1,
      'Unknown external outcome',
      now
    );

  const recoveryBlocked = await collectReleaseReadiness();
  assert.equal(recoveryBlocked.automatedReady, false);
  assert.equal(statusOf(recoveryBlocked, 'recovery_queue'), 'block');
  assert.ok(recoveryBlocked.automatedBlockers.some((message) => message.includes('RECOVERY_NEEDED')));

  db.prepare("UPDATE post_targets SET state='FAILED',last_error='Resolved for test',updated_at=? WHERE id=?").run(nowIso(), targetId);
  const recovered = await collectReleaseReadiness();
  assert.equal(recovered.automatedReady, true, JSON.stringify(recovered.automatedBlockers));

  const mediaId = id('med');
  const fakeRelativePath = `${postId}/${mediaId}.jpg`;
  db.prepare(`INSERT INTO media
    (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      mediaId,
      postId,
      'ghost.jpg',
      fakeRelativePath,
      'image/jpeg',
      1,
      1,
      1,
      '0'.repeat(64),
      nowIso(),
      0
    );

  const mediaBlocked = await collectReleaseReadiness();
  assert.equal(mediaBlocked.automatedReady, false);
  assert.equal(statusOf(mediaBlocked, 'media_consistency'), 'block');
  assert.equal(mediaBlocked.diagnostics.media.missingFiles, 1);
  db.prepare('DELETE FROM media WHERE id=?').run(mediaId);

  const { buildApp } = await import('../dist/app.js');
  const app = await buildApp();
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const unauth = await fetch(`${baseUrl}/api/release-readiness`);
    assert.equal(unauth.status, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'v08-readiness-password' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('publikator_session='));

    const response = await fetch(`${baseUrl}/api/release-readiness`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const httpReport = await response.json();
    assert.equal(httpReport.automatedReady, true);
    assert.equal(httpReport.stableV1Ready, false);

    const download = await fetch(`${baseUrl}/api/release-readiness/report.json`, { headers: { cookie } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') || '', /publikator-release-readiness-0\.8\.0-rc\.1\.json/);
    const downloadedReport = JSON.parse(await download.text());
    assert.equal(downloadedReport.releaseCandidate, '0.8.0-rc.1');
    assert.equal(downloadedReport.automatedReady, true);
    assert.equal(downloadedReport.stableV1Ready, false);
  } finally {
    await app.close();
  }

  console.log(JSON.stringify({
    ok: true,
    releaseCandidate: ready.releaseCandidate,
    automatedReadyAfterBackup: ready.automatedReady,
    stableV1Ready: ready.stableV1Ready,
    externalGate: statusOf(ready, 'live_platform_acceptance')
  }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
