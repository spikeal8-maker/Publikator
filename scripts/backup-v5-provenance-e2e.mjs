import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-backup-v5-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'backup-v5-ci-password';
process.env.APP_MASTER_KEY = 'backup-v5-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate } = await import('../dist/db.js');
const { config } = await import('../dist/config.js');
const { parseContentPlanV3, validateContentPlanV3, applyContentPlanV3 } = await import('../dist/content-plan-v3.js');
const { createBackupBundle, resolveBackupBundle, stageRestoreBundle } = await import('../dist/backups.js');
const { applyPendingRestore } = await import('../dist/restore-bootstrap.js');

migrate();
const columns = ['schema_version','external_id','action','project','template_key','internal_title','body','publication_kind','content_format','schedule_mode','scheduled_at','timezone','targets','telegram_body','vk_body','max_body','instagram_body','media','tags','source_note','source_revision'];
const values = ['3','restore-row','UPSERT','main','','Restore row','Canonical body','FEED','IMAGE','MANUAL','','UTC','[]','','','','','','','','rev-1'];
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const csv = Buffer.from('\uFEFF' + columns.join(';') + '\r\n' + values.map(quote).join(';') + '\r\n');const parsed = await parseContentPlanV3('restore.csv', csv);
const validation = await validateContentPlanV3(parsed, 'restore-source');
assert.equal(validation.canApply, true);
const imported = applyContentPlanV3(validation);
assert.equal(imported.created, 1);
const postId = imported.postIds[0];

const selectProvenance = `SELECT source_type,source_ref,source_revision,source_payload_hash,source_batch_id,imported_at,imported_content_version,content_version
  FROM posts WHERE id=?`;
const before = db.prepare(selectProvenance).get(postId);
assert.equal(before.source_type, 'content-plan-v3');
assert.equal(before.source_revision, 'rev-1');
assert.match(before.source_payload_hash, /^[a-f0-9]{64}$/);
assert.equal(before.imported_content_version, 1);
assert.equal(before.content_version, 1);

const bundle = await createBackupBundle('schema5-provenance');
const bundlePath = resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size > 0);

db.prepare(`UPDATE posts SET source_revision='mutated',source_payload_hash=?,source_batch_id='mutated-batch',imported_at='2099-01-01T00:00:00.000Z',imported_content_version=99 WHERE id=?`)
  .run('b'.repeat(64), postId);
const mutated = db.prepare(selectProvenance).get(postId);
assert.notDeepEqual(mutated, before);const staged = await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion, 5);

db.close();
const applied = await applyPendingRestore();
assert.equal(applied.applied, true);

const restoredDb = new Database(config.dbPath, { readonly: true, fileMustExist: true });try {
  assert.equal(Number(restoredDb.pragma('user_version', { simple: true })), 5);
  const after = restoredDb.prepare(selectProvenance).get(postId);
  assert.deepEqual(after, before);
  console.log(JSON.stringify({ ok: true, schemaVersion: 5, canonicalBundle: true, pendingRestoreApplied: true, ingestionProvenancePreserved: true }, null, 2));
} finally {
  restoredDb.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}