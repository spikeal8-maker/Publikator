import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CURRENT_SCHEMA_VERSION } from './current-schema-version.mjs';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-schema-v13-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='schema-v13-password';
process.env.APP_MASTER_KEY='schema-v13-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const {db,migrate}=await import('../dist/db.js');
const {DATABASE_SCHEMA_VERSION}=await import('../dist/schema.js');
const {createDraftPost}=await import('../dist/post-creation.js');
const {commitContentEdit}=await import('../dist/content-versioning.js');
const {plainTextToRichText,serializeRichText}=await import('../dist/rich-text.js');

migrate();
try {
  assert.equal(CURRENT_SCHEMA_VERSION,13);
  assert.equal(DATABASE_SCHEMA_VERSION,13);
  assert.equal(Number(db.pragma('user_version',{simple:true})),13);

  const project=db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
  const legacyPost=createDraftPost({
    projectId:project.id,
    title:'Schema 12 legacy',
    body:'Legacy body',
    bodyRichJson:serializeRichText(plainTextToRichText('Legacy body')),
    scheduleMode:'MANUAL'
  });
  const legacyProjection=()=>{
    return db.prepare(`SELECT id,project_id,title,body,body_rich_json,status,editorial_stage,schedule_mode,scheduled_at,
      scheduled_at_utc,schedule_timezone,publication_kind,content_format,content_version,ready_revision_id,
      source_type,source_ref,source_revision,source_payload_hash,source_batch_id,imported_at,imported_content_version,
      created_at,updated_at FROM posts WHERE id=?`).get(legacyPost.id);
  };
  const revisionProjection=()=>{
    return db.prepare(`SELECT id,post_id,content_version,title,body,body_rich_json,editorial_stage,schedule_mode,scheduled_at,
      scheduled_at_utc,schedule_timezone,publication_kind,content_format,targets_json,media_json,content_media_json,
      actor_source,restored_from_revision_id,created_at FROM content_revisions WHERE post_id=? ORDER BY content_version`).all(legacyPost.id);
  };
  const beforePost=legacyProjection();
  const beforeRevisions=revisionProjection();

  db.exec('DROP INDEX IF EXISTS idx_posts_campaign');
  for (const column of ['campaign','tags_json','source_note','editor_note']) {
    db.exec(`ALTER TABLE posts DROP COLUMN ${column}`);
  }
  for (const column of ['campaign','tags_json','source_note','editor_note']) {
    db.exec(`ALTER TABLE content_revisions DROP COLUMN ${column}`);
  }
  db.pragma('user_version = 12');

  assert.equal(Number(db.pragma('user_version',{simple:true})),12);
  assert.equal(db.prepare("SELECT 1 FROM pragma_table_info('posts') WHERE name='editor_note'").get(),undefined);

  migrate();
  assert.equal(Number(db.pragma('user_version',{simple:true})),13);
  for (const table of ['posts','content_revisions']) {
    const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row)=>row.name));
    for (const required of ['editor_note','source_note','tags_json','campaign']) assert.ok(columns.has(required),`${table}.${required}`);
  }
  const legacyMetadata=db.prepare('SELECT editor_note,source_note,tags_json,campaign FROM posts WHERE id=?').get(legacyPost.id);
  assert.deepEqual(legacyMetadata,{editor_note:null,source_note:null,tags_json:'[]',campaign:null});
  const legacyRevisionMetadata=db.prepare('SELECT editor_note,source_note,tags_json,campaign FROM content_revisions WHERE post_id=?').get(legacyPost.id);
  assert.deepEqual(legacyRevisionMetadata,{editor_note:null,source_note:null,tags_json:'[]',campaign:null});
  assert.deepEqual(legacyProjection(),beforePost);
  assert.deepEqual(revisionProjection(),beforeRevisions);

  const post=createDraftPost({
    projectId:project.id,
    title:'Editorial metadata',
    body:'Metadata v1',
    bodyRichJson:serializeRichText(plainTextToRichText('Metadata v1')),
    scheduleMode:'MANUAL',
    editorNote:'Проверить факты',
    sourceNote:'Материал редакции',
    tags:['школа','робототехника'],
    campaign:'Осень 2026'
  });
  assert.deepEqual(
    db.prepare('SELECT editor_note,source_note,tags_json,campaign FROM posts WHERE id=?').get(post.id),
    {editor_note:'Проверить факты',source_note:'Материал редакции',tags_json:'["школа","робототехника"]',campaign:'Осень 2026'}
  );
  assert.deepEqual(
    db.prepare('SELECT editor_note,source_note,tags_json,campaign FROM content_revisions WHERE post_id=? AND content_version=1').get(post.id),
    {editor_note:'Проверить факты',source_note:'Материал редакции',tags_json:'["школа","робототехника"]',campaign:'Осень 2026'}
  );

  const edited=commitContentEdit(post.id,1,'manual',()=>{
    db.prepare('UPDATE posts SET editor_note=?,source_note=?,tags_json=?,campaign=? WHERE id=?')
      .run('Готово к проверке','Обновлённый источник',JSON.stringify(['школа','осень']),'Осень 2026 / запуск',post.id);
  });
  assert.equal(edited.contentVersion,2);
  assert.deepEqual(
    db.prepare('SELECT editor_note,source_note,tags_json,campaign FROM content_revisions WHERE post_id=? AND content_version=2').get(post.id),
    {editor_note:'Готово к проверке',source_note:'Обновлённый источник',tags_json:'["школа","осень"]',campaign:'Осень 2026 / запуск'}
  );

  migrate();
  assert.equal(Number(db.pragma('user_version',{simple:true})),13);
  assert.deepEqual(
    db.prepare('SELECT editor_note,source_note,tags_json,campaign FROM posts WHERE id=?').get(post.id),
    {editor_note:'Готово к проверке',source_note:'Обновлённый источник',tags_json:'["школа","осень"]',campaign:'Осень 2026 / запуск'}
  );

  console.log(JSON.stringify({
    ok:true,
    from:12,
    to:13,
    additiveEditorialMetadata:true,
    oldContentPreserved:true,
    legacyDefaults:true,
    metadataVersioned:true,
    rerunSafe:true
  },null,2));
} finally {
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
