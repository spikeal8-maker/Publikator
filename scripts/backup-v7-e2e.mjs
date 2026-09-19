import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-backup-v7-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'backup-v7-ci-password';
process.env.APP_MASTER_KEY = 'backup-v7-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { config } = await import('../dist/config.js');
const { encryptJson } = await import('../dist/crypto.js');
const delivery = await import('../dist/delivery-foundation.js');
const { snapshotContentRevision } = await import('../dist/content-versioning.js');
const { createBackupBundle, resolveBackupBundle, stageRestoreBundle } = await import('../dist/backups.js');
const { applyPendingRestore } = await import('../dist/restore-bootstrap.js');

migrate();
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const accountId = id('acc');
const now = nowIso();
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`)
  .run(accountId, 'telegram', 'Backup v7', encryptJson({ botToken: 'mock', chatId: '@mock' }), now, now);
const postId = id('post');
db.prepare(`INSERT INTO posts
  (id,project_id,title,body,status,editorial_stage,schedule_mode,scheduled_at,scheduled_at_utc,schedule_timezone,
   publication_kind,content_format,content_version,ready_revision_id,created_at,updated_at)
  VALUES (?,?,?,?, 'DRAFT','DRAFT','AT',?,?,?,'STORY','STORY_SEQUENCE',1,NULL,?,?)`)
  .run(postId, projectId, 'Backup sequence', 'Body', '2026-11-01T06:30:00.000Z', '2026-11-01T06:30:00.000Z', 'America/New_York', now, now);
const targetId = id('pt');
db.prepare(`INSERT INTO post_targets
  (id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (?,?,?,1,'PENDING',0,?)`)
  .run(targetId, postId, accountId, now);
const renditionEdit = delivery.saveTargetRendition(targetId, { textPlain: 'Story caption', publicationKind: 'STORY', contentFormat: 'STORY_SEQUENCE' }, 1);
const revision = snapshotContentRevision(postId, renditionEdit.contentVersion, 'backup-v7');
const units = delivery.ensurePublicationUnits(targetId, revision.id, ['STORY','STORY','STORY']);
const first = delivery.claimNextPublicationUnit(targetId);
delivery.markPublicationUnitPublished(first.id, 'story-backup-1');
const second = delivery.claimNextPublicationUnit(targetId);
delivery.markPublicationUnitRecoveryNeeded(second.id, 'unknown outcome');
const postBefore = db.prepare(`SELECT scheduled_at_utc,schedule_timezone,publication_kind,content_format FROM posts WHERE id=?`).get(postId);
const renditionBefore = db.prepare('SELECT * FROM target_renditions WHERE target_id=?').get(targetId);
const unitsBefore = db.prepare('SELECT * FROM publication_units WHERE target_id=? ORDER BY unit_index').all(targetId);
const bundle = await createBackupBundle('schema7-time-rendition-sequence');
const bundlePath = resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size > 0);

db.prepare("UPDATE posts SET schedule_timezone='UTC',scheduled_at_utc='2030-01-01T00:00:00.000Z' WHERE id=?").run(postId);
db.prepare('DELETE FROM target_renditions WHERE target_id=?').run(targetId);
db.prepare('DELETE FROM publication_units WHERE target_id=?').run(targetId);
const staged = await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion, 11);
db.close();
const applied = await applyPendingRestore();
assert.equal(applied.applied, true);

const restored = new Database(config.dbPath, { readonly: true, fileMustExist: true });
try {
  assert.equal(Number(restored.pragma('user_version', { simple: true })), 11);
  assert.deepEqual(restored.prepare(`SELECT scheduled_at_utc,schedule_timezone,publication_kind,content_format FROM posts WHERE id=?`).get(postId), postBefore);
  assert.deepEqual(restored.prepare('SELECT * FROM target_renditions WHERE target_id=?').get(targetId), renditionBefore);
  assert.deepEqual(restored.prepare('SELECT * FROM publication_units WHERE target_id=? ORDER BY unit_index').all(targetId), unitsBefore);
  console.log(JSON.stringify({
    ok: true,
    schemaVersion: 11,
    scheduleTimezonePreserved: true,
    targetRenditionPreserved: true,
    publicationUnitRecoveryPreserved: true,
    pendingRestoreApplied: true
  }, null, 2));
} finally {
  restored.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
