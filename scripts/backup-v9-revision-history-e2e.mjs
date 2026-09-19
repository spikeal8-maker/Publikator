import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-backup-v9-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'backup-v9-ci-password';
process.env.APP_MASTER_KEY = 'backup-v9-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { config } = await import('../dist/config.js');
const { createInitialContentRevision, commitContentEdit } = await import('../dist/content-versioning.js');
const { restoreRevision } = await import('../dist/revision-history.js');
const { createBackupBundle, resolveBackupBundle, stageRestoreBundle } = await import('../dist/backups.js');
const { applyPendingRestore } = await import('../dist/restore-bootstrap.js');

migrate();
assert.equal(Number(db.pragma('user_version', { simple: true })), 10);

const projectId = id('prj');
const postId = id('post');
const now = nowIso();
db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)')
  .run(projectId, 'Backup v9', 'backup-v9', now);
db.prepare(`INSERT INTO posts
  (id,project_id,title,body,status,editorial_stage,schedule_mode,content_version,created_at,updated_at,publication_kind,content_format)
  VALUES (?,?,?,?,'DRAFT','DRAFT','MANUAL',1,?,?,'FEED','IMAGE')`)
  .run(postId, projectId, 'Revision A', 'Body A', now, now);

const revision1 = createInitialContentRevision(postId, 'manual');
const edit = commitContentEdit(postId, 1, 'manual', () => {
  db.prepare('UPDATE posts SET title=?,body=? WHERE id=?').run('Revision B', 'Body B', postId);
});
assert.equal(edit.contentVersion, 2);
const restored = await restoreRevision(postId, revision1.id, 2);
assert.equal(restored.contentVersion, 3);

const before = db.prepare(`SELECT id,post_id,content_version,title,body,editorial_stage,actor_source,restored_from_revision_id
  FROM content_revisions WHERE post_id=? ORDER BY content_version`).all(postId);
assert.deepEqual(before.map((row) => row.content_version), [1,2,3]);
assert.equal(before[2].actor_source, 'manual_restore');
assert.equal(before[2].restored_from_revision_id, revision1.id);

const bundle = await createBackupBundle('schema9-revision-history');
const bundlePath = resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size > 0);

db.prepare("UPDATE posts SET title='corrupt',body='corrupt' WHERE id=?").run(postId);
db.prepare("UPDATE content_revisions SET editorial_stage='APPROVED',restored_from_revision_id=NULL WHERE post_id=?").run(postId);
db.prepare('DELETE FROM publication_events WHERE post_id=?').run(postId);

const staged = await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion, 10);
db.close();
const applied = await applyPendingRestore();
assert.equal(applied.applied, true);

const restoredDb = new Database(config.dbPath, { readonly: true, fileMustExist: true });
try {
  assert.equal(Number(restoredDb.pragma('user_version', { simple: true })), 10);
  const after = restoredDb.prepare(`SELECT id,post_id,content_version,title,body,editorial_stage,actor_source,restored_from_revision_id
    FROM content_revisions WHERE post_id=? ORDER BY content_version`).all(postId);
  assert.deepEqual(after, before);
  assert.deepEqual(
    restoredDb.prepare('SELECT title,body,status,editorial_stage,content_version,ready_revision_id FROM posts WHERE id=?').get(postId),
    { title: 'Revision A', body: 'Body A', status: 'DRAFT', editorial_stage: 'DRAFT', content_version: 3, ready_revision_id: null }
  );
  const eventRow = restoredDb.prepare("SELECT event_type,data_json FROM publication_events WHERE post_id=? AND event_type='post_revision_restored'").get(postId);
  assert.ok(eventRow);
  assert.equal(JSON.parse(eventRow.data_json).restoredRevisionId, revision1.id);
  console.log(JSON.stringify({
    ok: true,
    schemaVersion: 10,
    revisionsPreserved: true,
    editorialStagePreserved: true,
    restoredFromPreserved: true,
    restoreAuditPreserved: true,
    pendingRestoreApplied: true
  }, null, 2));
} finally {
  restoredDb.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
