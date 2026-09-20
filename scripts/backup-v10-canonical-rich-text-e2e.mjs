import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION } from './current-schema-version.mjs';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-backup-v10-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='backup-v10-ci-password';
process.env.APP_MASTER_KEY='backup-v10-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const { db,migrate,id,nowIso }=await import('../dist/db.js');
const { config }=await import('../dist/config.js');
const { createInitialContentRevision,commitContentEdit }=await import('../dist/content-versioning.js');
const { createBackupBundle,resolveBackupBundle,stageRestoreBundle }=await import('../dist/backups.js');
const { applyPendingRestore }=await import('../dist/restore-bootstrap.js');
const { serializeRichText,richTextToPlain,parseRichTextJson }=await import('../dist/rich-text.js');

migrate();
assert.equal(Number(db.pragma('user_version',{simple:true})),CURRENT_SCHEMA_VERSION);

const projectId=id('prj');
const postId=id('post');
const now=nowIso();
const richA={type:'doc',content:[
  {type:'paragraph',content:[
    {type:'text',text:'Backup ',marks:[]},
    {type:'text',text:'rich',marks:[{type:'bold'},{type:'underline'}]},
    {type:'hard_break'},
    {type:'link',attrs:{href:'https://example.test/docs'},content:[{type:'text',text:'docs',marks:[]}]}
  ]}
]};
const richJsonA=serializeRichText(richA);
const plainA=richTextToPlain(richA);
db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)').run(projectId,'Backup v10','backup-v10',now);
db.prepare(`INSERT INTO posts
 (id,project_id,title,body,body_rich_json,status,editorial_stage,schedule_mode,content_version,created_at,updated_at,publication_kind,content_format)
 VALUES (?,?,?,?,?,'DRAFT','DRAFT','MANUAL',1,?,?,'FEED','TEXT_ONLY')`)
 .run(postId,projectId,'Rich A',plainA,richJsonA,now,now);

const revision1=createInitialContentRevision(postId,'manual');
const richB={type:'doc',content:[{type:'blockquote',content:[{type:'paragraph',content:[{type:'text',text:'Restorable 🙂',marks:[{type:'italic'}]}]}]}]};
const richJsonB=serializeRichText(richB);
const plainB=richTextToPlain(richB);
const edit=commitContentEdit(postId,1,'manual',()=>{
  db.prepare('UPDATE posts SET title=?,body=?,body_rich_json=? WHERE id=?').run('Rich B',plainB,richJsonB,postId);
});
assert.equal(edit.contentVersion,2);

const beforePost=db.prepare('SELECT title,body,body_rich_json,status,editorial_stage,content_version,ready_revision_id FROM posts WHERE id=?').get(postId);
const beforeRevisions=db.prepare(`SELECT id,post_id,content_version,title,body,body_rich_json,editorial_stage,actor_source,restored_from_revision_id
 FROM content_revisions WHERE post_id=? ORDER BY content_version`).all(postId);
assert.equal(beforeRevisions.length,2);
for(const row of beforeRevisions) assert.equal(richTextToPlain(parseRichTextJson(row.body_rich_json)),row.body);

const bundle=await createBackupBundle('schema10-canonical-rich-text');
const bundlePath=resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size>0);

const corruptRich=JSON.stringify({type:'doc',content:[]});
db.prepare('UPDATE posts SET body=?,body_rich_json=? WHERE id=?').run('corrupt',corruptRich,postId);
db.prepare('UPDATE content_revisions SET body=?,body_rich_json=? WHERE post_id=?').run('corrupt',corruptRich,postId);

const staged=await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion,CURRENT_SCHEMA_VERSION);
db.close();
const applied=await applyPendingRestore();
assert.equal(applied.applied,true);

const restoredDb=new Database(config.dbPath,{readonly:true,fileMustExist:true});
try{
  assert.equal(Number(restoredDb.pragma('user_version',{simple:true})),CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    restoredDb.prepare('SELECT title,body,body_rich_json,status,editorial_stage,content_version,ready_revision_id FROM posts WHERE id=?').get(postId),
    beforePost
  );
  const afterRevisions=restoredDb.prepare(`SELECT id,post_id,content_version,title,body,body_rich_json,editorial_stage,actor_source,restored_from_revision_id
    FROM content_revisions WHERE post_id=? ORDER BY content_version`).all(postId);
  assert.deepEqual(afterRevisions,beforeRevisions);
  for(const row of afterRevisions) assert.equal(richTextToPlain(parseRichTextJson(row.body_rich_json)),row.body);
  console.log(JSON.stringify({
    ok:true,
    schemaVersion:CURRENT_SCHEMA_VERSION,
    exactAstRestored:true,
    plainFallbackRestored:true,
    revisionsRestored:true,
    canonicalBackupRestore:true
  },null,2));
} finally {
  restoredDb.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
