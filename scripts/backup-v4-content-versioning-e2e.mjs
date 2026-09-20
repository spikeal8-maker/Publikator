import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION } from './current-schema-version.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-backup-v4-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'backup-v4-ci-password';
process.env.APP_MASTER_KEY = 'backup-v4-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { config } = await import('../dist/config.js');
const { createBackupBundle, resolveBackupBundle, stageRestoreBundle } = await import('../dist/backups.js');
const { applyPendingRestore } = await import('../dist/restore-bootstrap.js');

migrate();
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const postId = id('post');
const revisionId = id('rev');
const now = nowIso();
db.prepare(`INSERT INTO posts
  (id,project_id,title,body,status,editorial_stage,schedule_mode,content_version,ready_revision_id,created_at,updated_at)
  VALUES (?,?,?,?, 'READY','APPROVED','MANUAL',2,?,?,?)`)
  .run(postId, projectId, 'Versioned backup post', 'Canonical body', revisionId, now, now);
db.prepare(`INSERT INTO content_revisions
  (id,post_id,content_version,title,body,schedule_mode,scheduled_at,targets_json,media_json,actor_source,created_at)
  VALUES (?,?,?,?,?,'MANUAL',NULL,'[]','[]','backup-v4',?)`)
  .run(revisionId, postId, 2, 'Versioned backup post', 'Canonical body', now);

const postSelect = `SELECT status,editorial_stage,content_version,ready_revision_id,title,body FROM posts WHERE id=?`;
const revisionSelect = `SELECT id,post_id,content_version,title,body,actor_source FROM content_revisions WHERE id=?`;
const postBefore = db.prepare(postSelect).get(postId);
const revisionBefore = db.prepare(revisionSelect).get(revisionId);
assert.equal(postBefore.ready_revision_id, revisionId);
assert.equal(postBefore.content_version, 2);
const bundle = await createBackupBundle('schema4-content-versioning');
const bundlePath = resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size > 0);

db.prepare("UPDATE posts SET status='DRAFT',editorial_stage='DRAFT',content_version=9,ready_revision_id=NULL,title='Mutated' WHERE id=?").run(postId);
db.prepare('DELETE FROM content_revisions WHERE id=?').run(revisionId);

const staged = await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion,CURRENT_SCHEMA_VERSION);
db.close();
const applied = await applyPendingRestore();
assert.equal(applied.applied, true);

const restored = new Database(config.dbPath, { readonly: true, fileMustExist: true });
try {
  assert.equal(Number(restored.pragma('user_version', { simple: true })),CURRENT_SCHEMA_VERSION);
  assert.deepEqual(restored.prepare(postSelect).get(postId), postBefore);
  assert.deepEqual(restored.prepare(revisionSelect).get(revisionId), revisionBefore);
  console.log(JSON.stringify({
    ok: true,
    schemaVersion:CURRENT_SCHEMA_VERSION,
    contentVersionPreserved: true,
    readyRevisionPreserved: true,
    canonicalRevisionPreserved: true,
    pendingRestoreApplied: true
  }, null, 2));
} finally {
  restored.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
