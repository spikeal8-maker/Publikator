import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-v08-release-'));
process.env.DATA_DIR = dataDir;

const { config } = await import('../dist/config.js');
const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
const { createBackupBundle } = await import('../dist/backups.js');
const { extractBackupArchive } = await import('../dist/backup-format.js');
const { collectReleaseGate, setReleaseAcceptance } = await import('../dist/release-gate.js');

const releaseSha = process.env.APP_BUILD_SHA;
const adminPassword = process.env.ADMIN_PASSWORD;
assert.match(releaseSha || '', /^[a-f0-9]{40}$/);
assert.ok(adminPassword);

migrate();
assert.equal(Number(db.pragma('user_version', { simple: true })), 2);
assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='release_acceptance'").get());

const app = await buildApp();
await app.ready();

try {
  const anonymous = await app.inject({ method: 'GET', url: '/api/release-gate' });
  assert.equal(anonymous.statusCode, 401);

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: adminPassword } });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers['set-cookie'];
  assert.equal(typeof setCookie, 'string');
  const cookie = setCookie.split(';')[0];

  const authenticated = await app.inject({ method: 'GET', url: '/api/release-gate', headers: { cookie } });
  assert.equal(authenticated.statusCode, 200);
  assert.equal(authenticated.json().targetVersion, '1.0.0');

  const rejectedPass = await app.inject({
    method: 'PUT',
    url: '/api/release-gate/telegram',
    headers: { cookie },
    payload: {
      status: 'PASS',
      accountName: 'Telegram release test',
      commitSha: releaseSha,
      confirmation: 'PASS'
    }
  });
  assert.equal(rejectedPass.statusCode, 400);
  assert.match(rejectedPass.json().error, /LIVE PASS/);

  let gate = await collectReleaseGate();
  assert.equal(gate.targetVersion, '1.0.0');
  assert.equal(gate.appBuildSha, releaseSha);
  assert.equal(gate.releaseReady, false);
  assert.equal(gate.acceptance.length, 4);
  assert.equal(gate.acceptance.every((row) => row.status === 'NOT_TESTED'), true);

  for (const platform of ['telegram', 'vk', 'max', 'instagram']) {
    const result = setReleaseAcceptance({
      platform,
      status: 'PASS',
      accountName: `${platform} release test`,
      commitSha: releaseSha,
      notes: `Acceptance fixture for ${platform}`,
      confirmation: 'LIVE PASS'
    });
    assert.equal(result.status, 'PASS');
  }

  gate = await collectReleaseGate();
  assert.equal(gate.acceptanceCommitSha, releaseSha);
  assert.equal(gate.releaseReady, false);
  assert.equal(gate.blockers.some((item) => item.includes('backup')), true);

  const firstBundle = await createBackupBundle('release-gate-ci');
  gate = await collectReleaseGate();
  assert.equal(gate.releaseReady, true, JSON.stringify(gate.blockers));
  assert.equal(gate.backupAfterAcceptance, true);
  assert.equal(gate.requiresAutomatedCi, true);

  const extractDir = path.join(dataDir, 'release-evidence-check');
  await extractBackupArchive(path.join(config.backupDir, firstBundle.name), extractDir);
  const snapshot = new Database(path.join(extractDir, 'publikator.sqlite'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(Number(snapshot.pragma('user_version', { simple: true })), 2);
    const evidenceCount = Number(snapshot.prepare("SELECT COUNT(*) AS count FROM release_acceptance WHERE target_version='1.0.0' AND status='PASS'").get().count);
    assert.equal(evidenceCount, 4);
  } finally {
    snapshot.close();
  }

  setReleaseAcceptance({
    platform: 'instagram',
    status: 'FAIL',
    accountName: 'instagram release test',
    commitSha: releaseSha,
    notes: 'Intentional regression fixture'
  });
  gate = await collectReleaseGate();
  assert.equal(gate.releaseReady, false);

  setReleaseAcceptance({
    platform: 'instagram',
    status: 'PASS',
    accountName: 'instagram release test',
    commitSha: releaseSha,
    notes: 'Retested after fixture',
    confirmation: 'LIVE PASS'
  });
  gate = await collectReleaseGate();
  assert.equal(gate.releaseReady, false);
  assert.equal(gate.backupAfterAcceptance, false);

  await createBackupBundle('release-gate-ci-after-retest');
  gate = await collectReleaseGate();
  assert.equal(gate.releaseReady, true, JSON.stringify(gate.blockers));

  setReleaseAcceptance({
    platform: 'vk',
    status: 'PASS',
    accountName: 'vk release test',
    commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    notes: 'Intentional SHA mismatch fixture',
    confirmation: 'LIVE PASS'
  });
  gate = await collectReleaseGate();
  assert.equal(gate.releaseReady, false);
  assert.equal(gate.blockers.some((item) => item.includes('разных commit SHA')), true);

  const reset = setReleaseAcceptance({ platform: 'vk', status: 'NOT_TESTED' });
  assert.equal(reset.status, 'NOT_TESTED');

  const auditCount = Number(db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE event_type IN ('release_acceptance_updated','release_acceptance_reset')").get().count);
  assert.ok(auditCount >= 7);

  console.log(JSON.stringify({ ok: true, releaseSha, firstBundle: firstBundle.name, auditCount }, null, 2));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
