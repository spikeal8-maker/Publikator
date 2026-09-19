import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-schema-v11-'));
const dbPath=path.join(dataDir,'publikator.sqlite');
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='schema-v11-ci-password';
process.env.APP_MASTER_KEY='schema-v11-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const legacy=new Database(dbPath);
legacy.exec(`
PRAGMA foreign_keys=ON;
CREATE TABLE projects(
  id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL
);
CREATE TABLE social_accounts(
  id TEXT PRIMARY KEY,platform TEXT NOT NULL,name TEXT NOT NULL,credentials_encrypted TEXT NOT NULL,
  enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE posts(
  id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,body_rich_json TEXT NOT NULL,
  status TEXT NOT NULL,editorial_stage TEXT NOT NULL,schedule_mode TEXT NOT NULL,scheduled_at TEXT,content_version INTEGER NOT NULL,
  ready_revision_id TEXT,source_type TEXT,source_ref TEXT,source_revision TEXT,source_payload_hash TEXT,source_batch_id TEXT,
  imported_at TEXT,imported_content_version INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  scheduled_at_utc TEXT,schedule_timezone TEXT,publication_kind TEXT NOT NULL,content_format TEXT NOT NULL
);
CREATE TABLE content_revisions(
  id TEXT PRIMARY KEY,post_id TEXT NOT NULL,content_version INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,body_rich_json TEXT NOT NULL,
  editorial_stage TEXT NOT NULL,schedule_mode TEXT NOT NULL,scheduled_at TEXT,targets_json TEXT NOT NULL,media_json TEXT NOT NULL,
  actor_source TEXT NOT NULL,created_at TEXT NOT NULL,scheduled_at_utc TEXT,schedule_timezone TEXT,
  publication_kind TEXT NOT NULL,content_format TEXT NOT NULL,content_media_json TEXT NOT NULL,
  restored_from_revision_id TEXT,UNIQUE(post_id,content_version)
);
CREATE TABLE media(
  id TEXT PRIMARY KEY,post_id TEXT NOT NULL,original_name TEXT NOT NULL,relative_path TEXT NOT NULL,mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,width INTEGER,height INTEGER,sha256 TEXT NOT NULL,created_at TEXT NOT NULL,sort_order INTEGER NOT NULL,
  duration_ms INTEGER,fps REAL,video_codec TEXT,audio_codec TEXT,container TEXT,poster_asset_id TEXT
);
CREATE TABLE content_media(
  id TEXT PRIMARY KEY,post_id TEXT NOT NULL,media_id TEXT NOT NULL,sort_order INTEGER NOT NULL,role TEXT NOT NULL,
  preview_duration_ms INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(post_id,media_id)
);
CREATE TABLE post_targets(
  id TEXT PRIMARY KEY,post_id TEXT NOT NULL,account_id TEXT NOT NULL,enabled INTEGER NOT NULL,override_text TEXT,
  state TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt_at TEXT,external_id TEXT,external_url TEXT,last_error TEXT,
  published_at TEXT,updated_at TEXT NOT NULL,UNIQUE(post_id,account_id)
);
CREATE TABLE target_renditions(
  target_id TEXT PRIMARY KEY,text_rich_json TEXT,text_plain TEXT,publication_kind TEXT,content_format TEXT,
  media_plan_json TEXT,options_json TEXT,updated_at TEXT NOT NULL
);
CREATE TABLE publication_units(
  id TEXT PRIMARY KEY,target_id TEXT NOT NULL,revision_id TEXT NOT NULL,unit_index INTEGER NOT NULL,unit_type TEXT NOT NULL,
  state TEXT NOT NULL,attempts INTEGER NOT NULL,external_id TEXT,external_url TEXT,last_error TEXT,published_at TEXT,
  updated_at TEXT NOT NULL,UNIQUE(target_id,revision_id,unit_index)
);
CREATE TABLE schedule_slots(
  id TEXT PRIMARY KEY,project_id TEXT NOT NULL,weekday INTEGER NOT NULL,time_hhmm TEXT NOT NULL,timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL,last_fired_on TEXT,created_at TEXT NOT NULL
);
CREATE TABLE publication_events(
  id TEXT PRIMARY KEY,post_id TEXT,account_id TEXT,level TEXT NOT NULL,event_type TEXT NOT NULL,message TEXT NOT NULL,
  data_json TEXT,created_at TEXT NOT NULL
);
CREATE TABLE release_acceptance(
  id TEXT PRIMARY KEY,target_version TEXT NOT NULL,platform TEXT NOT NULL,status TEXT NOT NULL,commit_sha TEXT NOT NULL,
  account_name TEXT NOT NULL,tested_at TEXT NOT NULL,notes TEXT,updated_at TEXT NOT NULL,UNIQUE(target_version,platform)
);
CREATE TABLE integration_api_keys(
  id TEXT PRIMARY KEY,name TEXT NOT NULL,prefix TEXT NOT NULL,key_hash TEXT NOT NULL UNIQUE,scopes_json TEXT NOT NULL,
  revoked_at TEXT,created_at TEXT NOT NULL,last_used_at TEXT,rotated_from_id TEXT
);
CREATE TABLE ingestion_connectors(
  id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,config_json TEXT NOT NULL,credentials_encrypted TEXT NOT NULL,
  enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
`);

const ts='2026-09-19T00:00:00.000Z';
const rich=JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Schema 10 body',marks:[]}]}]});
legacy.prepare('INSERT INTO projects(id,name,slug,created_at) VALUES (?,?,?,?)').run('p1','Existing project','existing',ts);
legacy.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
  .run('acc-enabled','telegram','Enabled account','encrypted',1,ts,ts);
legacy.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
  .run('acc-disabled','vk','Disabled account','encrypted',0,ts,ts);
legacy.prepare(`INSERT INTO posts
  (id,project_id,title,body,body_rich_json,status,editorial_stage,schedule_mode,scheduled_at,content_version,
   created_at,updated_at,scheduled_at_utc,schedule_timezone,publication_kind,content_format)
  VALUES (?,?,?,?,?,'DRAFT','DRAFT','AT',?,7,?,?,?,?,'FEED','TEXT_ONLY')`)
  .run('post1','p1','Existing post','Schema 10 body',rich,'2026-10-01T13:00:00.000Z',ts,ts,'2026-10-01T13:00:00.000Z','America/New_York');
legacy.prepare(`INSERT INTO content_revisions
  (id,post_id,content_version,title,body,body_rich_json,editorial_stage,schedule_mode,scheduled_at,targets_json,media_json,
   actor_source,created_at,scheduled_at_utc,schedule_timezone,publication_kind,content_format,content_media_json)
  VALUES (?,?,?,?,?,?,'DRAFT','AT',?,'[]','[]','manual',?,?,?,?,?,'[]')`)
  .run('rev1','post1',7,'Existing post','Schema 10 body',rich,'2026-10-01T13:00:00.000Z',ts,
    '2026-10-01T13:00:00.000Z','America/New_York','FEED','TEXT_ONLY');
legacy.prepare(`INSERT INTO schedule_slots
  (id,project_id,weekday,time_hhmm,timezone,enabled,last_fired_on,created_at)
  VALUES (?,?,?,?,?,1,NULL,?)`).run('slot1','p1',1,'09:30','Europe/Moscow',ts);
legacy.prepare(`INSERT INTO post_targets
  (id,post_id,account_id,enabled,override_text,state,attempts,next_attempt_at,external_id,external_url,last_error,published_at,updated_at)
  VALUES (?,?,?,?,?,'PENDING',0,NULL,NULL,NULL,NULL,NULL,?)`)
  .run('target1','post1','acc-enabled',0,'historical override',ts);
legacy.pragma('user_version = 10');

const postBefore=legacy.prepare('SELECT * FROM posts WHERE id=?').get('post1');
const revisionsBefore=legacy.prepare('SELECT * FROM content_revisions WHERE post_id=? ORDER BY content_version').all('post1');
const schedulesBefore=legacy.prepare('SELECT * FROM schedule_slots WHERE project_id=? ORDER BY id').all('p1');
const targetsBefore=legacy.prepare('SELECT * FROM post_targets WHERE post_id=? ORDER BY id').all('post1');
legacy.close();

const {db,migrate}=await import('../dist/db.js');
const {DATABASE_SCHEMA_VERSION}=await import('../dist/schema.js');
const {migrateProjectDefaults}=await import('../dist/project-defaults-migration.js');

migrate();
try{
  assert.equal(DATABASE_SCHEMA_VERSION,11);
  assert.equal(Number(db.pragma('user_version',{simple:true})),11);

  const projectColumns=new Set(db.prepare('PRAGMA table_info(projects)').all().map((row)=>row.name));
  assert.ok(projectColumns.has('default_timezone'));
  assert.equal(db.prepare('SELECT default_timezone FROM projects WHERE id=?').get('p1').default_timezone,'UTC');
  const defaultTargetColumns=new Set(db.prepare('PRAGMA table_info(project_default_targets)').all().map((row)=>row.name));
  assert.deepEqual([...defaultTargetColumns].sort(),['account_id','created_at','project_id']);
  assert.deepEqual(
    db.prepare('SELECT project_id,account_id,created_at FROM project_default_targets ORDER BY account_id').all(),
    [{project_id:'p1',account_id:'acc-enabled',created_at:ts}]
  );

  assert.deepEqual(db.prepare('SELECT * FROM posts WHERE id=?').get('post1'),postBefore);
  assert.deepEqual(db.prepare('SELECT * FROM content_revisions WHERE post_id=? ORDER BY content_version').all('post1'),revisionsBefore);
  assert.deepEqual(db.prepare('SELECT * FROM schedule_slots WHERE project_id=? ORDER BY id').all('p1'),schedulesBefore);
  assert.deepEqual(db.prepare('SELECT * FROM post_targets WHERE post_id=? ORDER BY id').all('post1'),targetsBefore);

  db.prepare('DELETE FROM project_default_targets WHERE project_id=?').run('p1');
  db.prepare('UPDATE projects SET default_timezone=? WHERE id=?').run('Asia/Tokyo','p1');
  migrateProjectDefaults(db);
  assert.equal(db.prepare('SELECT default_timezone FROM projects WHERE id=?').get('p1').default_timezone,'Asia/Tokyo');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_default_targets WHERE project_id=?').get('p1').count,0);

  migrate();
  assert.equal(Number(db.pragma('user_version',{simple:true})),11);
  assert.equal(db.prepare('SELECT default_timezone FROM projects WHERE id=?').get('p1').default_timezone,'Asia/Tokyo');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_default_targets WHERE project_id=?').get('p1').count,0);
  assert.deepEqual(db.prepare('SELECT * FROM posts WHERE id=?').get('post1'),postBefore);
  assert.deepEqual(db.prepare('SELECT * FROM content_revisions WHERE post_id=? ORDER BY content_version').all('post1'),revisionsBefore);
  assert.deepEqual(db.prepare('SELECT * FROM schedule_slots WHERE project_id=? ORDER BY id').all('p1'),schedulesBefore);
  assert.deepEqual(db.prepare('SELECT * FROM post_targets WHERE post_id=? ORDER BY id').all('post1'),targetsBefore);

  console.log(JSON.stringify({
    ok:true,
    from:10,
    to:11,
    projectDefaultTimezone:true,
    projectDefaultTargetsBackfilled:true,
    defaultTargetCreatedAt:true,
    disabledAccountExcluded:true,
    existingProjectUtc:true,
    postsUnchanged:true,
    postTargetsUnchanged:true,
    revisionsUnchanged:true,
    schedulesUnchanged:true,
    rerunSafe:true,
    emptyDefaultsRemainEmpty:true,
    databaseSchemaVersion:11
  },null,2));
}finally{
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
