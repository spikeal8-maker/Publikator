import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema-v10-'));
const dbPath = path.join(dataDir, 'publikator.sqlite');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'schema-v10-ci-password';
process.env.APP_MASTER_KEY = 'schema-v10-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const legacy = new Database(dbPath);
legacy.exec(`
PRAGMA foreign_keys=ON;
CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
CREATE TABLE social_accounts(id TEXT PRIMARY KEY,platform TEXT NOT NULL,name TEXT NOT NULL,credentials_encrypted TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE posts(
  id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,
  editorial_stage TEXT NOT NULL,schedule_mode TEXT NOT NULL,scheduled_at TEXT,content_version INTEGER NOT NULL,
  ready_revision_id TEXT,source_type TEXT,source_ref TEXT,source_revision TEXT,source_payload_hash TEXT,source_batch_id TEXT,
  imported_at TEXT,imported_content_version INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  scheduled_at_utc TEXT,schedule_timezone TEXT,publication_kind TEXT NOT NULL DEFAULT 'FEED',content_format TEXT NOT NULL DEFAULT 'IMAGE'
);
CREATE TABLE content_revisions(
  id TEXT PRIMARY KEY,post_id TEXT NOT NULL,content_version INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,
  editorial_stage TEXT NOT NULL DEFAULT 'DRAFT',schedule_mode TEXT NOT NULL,scheduled_at TEXT,targets_json TEXT NOT NULL,
  media_json TEXT NOT NULL,actor_source TEXT NOT NULL,created_at TEXT NOT NULL,scheduled_at_utc TEXT,schedule_timezone TEXT,
  publication_kind TEXT NOT NULL DEFAULT 'FEED',content_format TEXT NOT NULL DEFAULT 'IMAGE',
  content_media_json TEXT NOT NULL DEFAULT '[]',restored_from_revision_id TEXT,UNIQUE(post_id,content_version)
);
CREATE TABLE media(
  id TEXT PRIMARY KEY,post_id TEXT NOT NULL,original_name TEXT NOT NULL,relative_path TEXT NOT NULL,mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,width INTEGER,height INTEGER,sha256 TEXT NOT NULL,created_at TEXT NOT NULL,sort_order INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,fps REAL,video_codec TEXT,audio_codec TEXT,container TEXT,poster_asset_id TEXT
);
CREATE TABLE content_media(
  id TEXT PRIMARY KEY,post_id TEXT NOT NULL,media_id TEXT NOT NULL,sort_order INTEGER NOT NULL,role TEXT NOT NULL,
  preview_duration_ms INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(post_id,media_id)
);
CREATE TABLE post_targets(
  id TEXT PRIMARY KEY,post_id TEXT NOT NULL,account_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,override_text TEXT,
  state TEXT NOT NULL DEFAULT 'PENDING',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,external_id TEXT,external_url TEXT,
  last_error TEXT,published_at TEXT,updated_at TEXT NOT NULL,UNIQUE(post_id,account_id)
);
CREATE TABLE target_renditions(
  target_id TEXT PRIMARY KEY,text_rich_json TEXT,text_plain TEXT,publication_kind TEXT,content_format TEXT,
  media_plan_json TEXT,options_json TEXT,updated_at TEXT NOT NULL
);
CREATE TABLE publication_units(
  id TEXT PRIMARY KEY,target_id TEXT NOT NULL,revision_id TEXT NOT NULL,unit_index INTEGER NOT NULL,unit_type TEXT NOT NULL,
  state TEXT NOT NULL,attempts INTEGER NOT NULL,external_id TEXT,external_url TEXT,last_error TEXT,published_at TEXT,updated_at TEXT NOT NULL,
  UNIQUE(target_id,revision_id,unit_index)
);
CREATE TABLE schedule_slots(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,weekday INTEGER NOT NULL,time_hhmm TEXT NOT NULL,timezone TEXT NOT NULL,enabled INTEGER NOT NULL,last_fired_on TEXT,created_at TEXT NOT NULL);
CREATE TABLE publication_events(id TEXT PRIMARY KEY,post_id TEXT,account_id TEXT,level TEXT NOT NULL,event_type TEXT NOT NULL,message TEXT NOT NULL,data_json TEXT,created_at TEXT NOT NULL);
CREATE TABLE release_acceptance(id TEXT PRIMARY KEY,target_version TEXT NOT NULL,platform TEXT NOT NULL,status TEXT NOT NULL,commit_sha TEXT NOT NULL,account_name TEXT NOT NULL,tested_at TEXT NOT NULL,notes TEXT,updated_at TEXT NOT NULL,UNIQUE(target_version,platform));
CREATE TABLE integration_api_keys(id TEXT PRIMARY KEY,name TEXT NOT NULL,prefix TEXT NOT NULL,key_hash TEXT NOT NULL UNIQUE,scopes_json TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL,last_used_at TEXT,rotated_from_id TEXT);
CREATE TABLE ingestion_connectors(id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,config_json TEXT NOT NULL,credentials_encrypted TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
`);

const ts='2026-01-01T00:00:00.000Z';
const legacyBody='Строка 1\n\n**текст** — literal, 🙂 Кириллица <tag> & "quotes"';
const publishedBody='Опубликовано\nбез изменения semantics';
legacy.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('p1','Schema9','schema9',ts);
legacy.prepare('INSERT INTO social_accounts VALUES (?,?,?,?,?,?,?)').run('a1','telegram','Channel','encrypted',1,ts,ts);
legacy.prepare(`INSERT INTO posts
 (id,project_id,title,body,status,editorial_stage,schedule_mode,scheduled_at,content_version,ready_revision_id,
  source_type,source_ref,source_revision,source_payload_hash,source_batch_id,imported_at,imported_content_version,
  created_at,updated_at,scheduled_at_utc,schedule_timezone,publication_kind,content_format)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
 .run('ready','p1','Ready title',legacyBody,'READY','APPROVED','MANUAL',null,2,'rev-ready',null,null,null,null,null,null,null,ts,ts,null,null,'FEED','TEXT_ONLY');
legacy.prepare(`INSERT INTO posts
 (id,project_id,title,body,status,editorial_stage,schedule_mode,scheduled_at,content_version,ready_revision_id,
  source_type,source_ref,source_revision,source_payload_hash,source_batch_id,imported_at,imported_content_version,
  created_at,updated_at,scheduled_at_utc,schedule_timezone,publication_kind,content_format)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
 .run('published','p1','Published title',publishedBody,'PUBLISHED','APPROVED','MANUAL',null,4,'rev-published',null,null,null,null,null,null,null,ts,ts,null,null,'FEED','TEXT_ONLY');
legacy.prepare(`INSERT INTO content_revisions
 (id,post_id,content_version,title,body,editorial_stage,schedule_mode,scheduled_at,targets_json,media_json,actor_source,created_at,
  scheduled_at_utc,schedule_timezone,publication_kind,content_format,content_media_json,restored_from_revision_id)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
 .run('rev-base','ready',1,'Base title','Base\n\n**старое**','DRAFT','MANUAL',null,'[]','[]','manual',ts,null,null,'FEED','TEXT_ONLY','[]',null);
legacy.prepare(`INSERT INTO content_revisions
 (id,post_id,content_version,title,body,editorial_stage,schedule_mode,scheduled_at,targets_json,media_json,actor_source,created_at,
  scheduled_at_utc,schedule_timezone,publication_kind,content_format,content_media_json,restored_from_revision_id)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
 .run('rev-ready','ready',2,'Ready title',legacyBody,'APPROVED','MANUAL',null,'[]','[]','manual_restore',ts,null,null,'FEED','TEXT_ONLY','[]','rev-base');
legacy.prepare(`INSERT INTO content_revisions
 (id,post_id,content_version,title,body,editorial_stage,schedule_mode,scheduled_at,targets_json,media_json,actor_source,created_at,
  scheduled_at_utc,schedule_timezone,publication_kind,content_format,content_media_json,restored_from_revision_id)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
 .run('rev-published','published',4,'Published title',publishedBody,'APPROVED','MANUAL',null,
   JSON.stringify([{targetId:'t1',accountId:'a1',enabled:true,overrideText:null,rendition:{textRichJson:null,textPlain:'target plain',publicationKind:null,contentFormat:null,mediaPlanJson:null,optionsJson:null}}]),
   '[]','manual',ts,null,null,'FEED','TEXT_ONLY','[]',null);
legacy.prepare(`INSERT INTO post_targets
 (id,post_id,account_id,enabled,override_text,state,attempts,updated_at)
 VALUES (?,?,?,?,?,'PENDING',0,?)`).run('t1','published','a1',1,null,ts);
const targetRichJson=JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Target literal **text**',marks:[]}]}]});
legacy.prepare(`INSERT INTO target_renditions
 (target_id,text_rich_json,text_plain,publication_kind,content_format,media_plan_json,options_json,updated_at)
 VALUES (?,?,?,?,?,?,?,?)`).run('t1',targetRichJson,'Target literal **text**',null,null,null,null,ts);
legacy.pragma('user_version = 9');

const publishedBefore=legacy.prepare(`SELECT id,title,body,status,editorial_stage,content_version,ready_revision_id,
 schedule_mode,scheduled_at,scheduled_at_utc,schedule_timezone,publication_kind,content_format
 FROM posts WHERE id='published'`).get();
const targetBefore=legacy.prepare('SELECT * FROM target_renditions WHERE target_id=?').get('t1');
legacy.close();

const { db,migrate }=await import('../dist/db.js');
const { DATABASE_SCHEMA_VERSION }=await import('../dist/schema.js');
const { migrateCanonicalRichText }=await import('../dist/canonical-rich-text-migration.js');
const { parseRichTextJson,richTextToPlain,serializeRichText }=await import('../dist/rich-text.js');

migrate();
try{
  assert.equal(DATABASE_SCHEMA_VERSION,10);
  assert.equal(Number(db.pragma('user_version',{simple:true})),10);

  const postColumns=new Set(db.prepare('PRAGMA table_info(posts)').all().map(row=>row.name));
  const revisionColumns=new Set(db.prepare('PRAGMA table_info(content_revisions)').all().map(row=>row.name));
  assert.ok(postColumns.has('body_rich_json'));
  assert.ok(revisionColumns.has('body_rich_json'));

  for(const row of db.prepare('SELECT id,body,body_rich_json FROM posts ORDER BY id').all()){
    assert.equal(richTextToPlain(parseRichTextJson(row.body_rich_json)),row.body,`post plain roundtrip: ${row.id}`);
  }
  for(const row of db.prepare('SELECT id,body,body_rich_json FROM content_revisions ORDER BY id').all()){
    assert.equal(richTextToPlain(parseRichTextJson(row.body_rich_json)),row.body,`revision plain roundtrip: ${row.id}`);
  }

  const migratedReady=db.prepare('SELECT body,body_rich_json,ready_revision_id FROM posts WHERE id=?').get('ready');
  assert.equal(migratedReady.body,legacyBody);
  assert.equal(richTextToPlain(parseRichTextJson(migratedReady.body_rich_json)),legacyBody);
  assert.equal(parseRichTextJson(migratedReady.body_rich_json).content[0].content[0].text,legacyBody);
  assert.equal(db.prepare('SELECT editorial_stage,restored_from_revision_id FROM content_revisions WHERE id=?').get('rev-ready').editorial_stage,'APPROVED');
  assert.equal(db.prepare('SELECT restored_from_revision_id FROM content_revisions WHERE id=?').get('rev-ready').restored_from_revision_id,'rev-base');
  assert.deepEqual(db.prepare('SELECT * FROM target_renditions WHERE target_id=?').get('t1'),targetBefore);
  assert.deepEqual(db.prepare(`SELECT id,title,body,status,editorial_stage,content_version,ready_revision_id,
    schedule_mode,scheduled_at,scheduled_at_utc,schedule_timezone,publication_kind,content_format
    FROM posts WHERE id='published'`).get(),publishedBefore);

  const custom={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:legacyBody,marks:[{type:'bold'}]}]}]};
  const customJson=serializeRichText(custom);
  db.prepare('UPDATE posts SET body_rich_json=? WHERE id=?').run(customJson,'ready');
  migrateCanonicalRichText(db);
  assert.equal(db.prepare('SELECT body_rich_json FROM posts WHERE id=?').get('ready').body_rich_json,customJson,'migration helper rerun must not overwrite rich state');

  migrate();
  assert.equal(Number(db.pragma('user_version',{simple:true})),10);
  assert.equal(db.prepare('SELECT body_rich_json FROM posts WHERE id=?').get('ready').body_rich_json,customJson);

  console.log(JSON.stringify({
    ok:true,
    from:9,
    to:10,
    exactPlainRoundtrip:true,
    literalMarkdownPreserved:true,
    unicodeEmojiPreserved:true,
    readyRevisionPreserved:true,
    restoredFromPreserved:true,
    targetRenditionsPreserved:true,
    publishedContentPreserved:true,
    rerunSafe:true
  },null,2));
} finally {
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
