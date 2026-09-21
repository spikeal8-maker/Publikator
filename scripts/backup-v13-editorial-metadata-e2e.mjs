import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION } from './current-schema-version.mjs';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-backup-v13-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='backup-v13-password';
process.env.APP_MASTER_KEY='backup-v13-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const {db,migrate}=await import('../dist/db.js');
const {config}=await import('../dist/config.js');
const {createDraftPost}=await import('../dist/post-creation.js');
const {commitContentEdit}=await import('../dist/content-versioning.js');
const {plainTextToRichText,serializeRichText}=await import('../dist/rich-text.js');
const {createBackupBundle,resolveBackupBundle,stageRestoreBundle}=await import('../dist/backups.js');
const {applyPendingRestore}=await import('../dist/restore-bootstrap.js');

migrate();
assert.equal(CURRENT_SCHEMA_VERSION,13);
assert.equal(Number(db.pragma('user_version',{simple:true})),13);

const project=db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
const post=createDraftPost({
  projectId:project.id,
  title:'Backup editorial metadata',
  body:'Metadata backup body',
  bodyRichJson:serializeRichText(plainTextToRichText('Metadata backup body')),
  scheduleMode:'MANUAL',
  editorNote:'Проверить перед публикацией',
  sourceNote:'Источник: редакция',
  tags:['backup','редакция'],
  campaign:'Кампания 13'
});
commitContentEdit(post.id,1,'manual',()=>{
  db.prepare('UPDATE posts SET editor_note=?,source_note=?,tags_json=?,campaign=? WHERE id=?')
    .run('Одобрить формулировку','Источник: обновлён',JSON.stringify(['backup','v2']),'Кампания 13 v2',post.id);
});
const postBefore=db.prepare('SELECT * FROM posts WHERE id=?').get(post.id);
const revisionsBefore=db.prepare('SELECT * FROM content_revisions WHERE post_id=? ORDER BY content_version').all(post.id);
assert.equal(revisionsBefore.length,2);

const bundle=await createBackupBundle('schema13-editorial-metadata');
const bundlePath=resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size>0);

db.prepare('UPDATE posts SET editor_note=?,source_note=?,tags_json=?,campaign=? WHERE id=?')
  .run('MUTATED','MUTATED','[]','MUTATED',post.id);
db.prepare('DELETE FROM content_revisions WHERE post_id=?').run(post.id);

const staged=await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion,13);
db.close();

const applied=await applyPendingRestore();
assert.equal(applied.applied,true);

const restored=new Database(config.dbPath,{readonly:true,fileMustExist:true});
try {
  assert.equal(Number(restored.pragma('user_version',{simple:true})),13);
  assert.deepEqual(restored.prepare('SELECT * FROM posts WHERE id=?').get(post.id),postBefore);
  assert.deepEqual(restored.prepare('SELECT * FROM content_revisions WHERE post_id=? ORDER BY content_version').all(post.id),revisionsBefore);
  console.log(JSON.stringify({
    ok:true,
    schemaVersion:13,
    editorialMetadataRestored:true,
    revisionMetadataRestored:true,
    canonicalBackupRestore:true
  },null,2));
} finally {
  restored.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
