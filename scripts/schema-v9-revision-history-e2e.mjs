import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema-v9-'));
const dbPath = path.join(dataDir, 'publikator.sqlite');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'schema-v9-ci-password';
process.env.APP_MASTER_KEY = 'schema-v9-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const legacy = new Database(dbPath);
legacy.exec(`PRAGMA foreign_keys=ON;
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
  schedule_mode TEXT NOT NULL,scheduled_at TEXT,targets_json TEXT NOT NULL,media_json TEXT NOT NULL,actor_source TEXT NOT NULL,
  created_at TEXT NOT NULL,scheduled_at_utc TEXT,schedule_timezone TEXT,publication_kind TEXT NOT NULL DEFAULT 'FEED',
  content_format TEXT NOT NULL DEFAULT 'IMAGE',content_media_json TEXT NOT NULL DEFAULT '[]',UNIQUE(post_id,content_version)
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
CREATE TABLE schedule_slots(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,weekday INTEGER NOT NULL,time_hhmm TEXT NOT NULL,timezone TEXT NOT NULL,enabled INTEGER NOT NULL,last_fired_on TEXT,created_at TEXT NOT NULL);
CREATE TABLE publication_events(id TEXT PRIMARY KEY,post_id TEXT,account_id TEXT,level TEXT NOT NULL,event_type TEXT NOT NULL,message TEXT NOT NULL,data_json TEXT,created_at TEXT NOT NULL);
CREATE TABLE release_acceptance(id TEXT PRIMARY KEY,target_version TEXT NOT NULL,platform TEXT NOT NULL,status TEXT NOT NULL,commit_sha TEXT NOT NULL,account_name TEXT NOT NULL,tested_at TEXT NOT NULL,notes TEXT,updated_at TEXT NOT NULL,UNIQUE(target_version,platform));
CREATE TABLE integration_api_keys(id TEXT PRIMARY KEY,name TEXT NOT NULL,prefix TEXT NOT NULL,key_hash TEXT NOT NULL UNIQUE,scopes_json TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL,last_used_at TEXT,rotated_from_id TEXT);
CREATE TABLE ingestion_connectors(id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,config_json TEXT NOT NULL,credentials_encrypted TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE target_renditions(target_id TEXT PRIMARY KEY,text_rich_json TEXT,text_plain TEXT,publication_kind TEXT,content_format TEXT,media_plan_json TEXT,options_json TEXT,updated_at TEXT NOT NULL);
CREATE TABLE publication_units(id TEXT PRIMARY KEY,target_id TEXT NOT NULL,revision_id TEXT NOT NULL,unit_index INTEGER NOT NULL,unit_type TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,external_id TEXT,external_url TEXT,last_error TEXT,published_at TEXT,updated_at TEXT NOT NULL);
`);

const ts = '2026-01-01T00:00:00.000Z';
legacy.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('p1','Schema8','schema8',ts);
legacy.prepare('INSERT INTO social_accounts VALUES (?,?,?,?,?,?,?)').run('a1','telegram','Channel','encrypted',1,ts,ts);
legacy.prepare(`INSERT INTO posts
  (id,project_id,title,body,status,editorial_stage,schedule_mode,scheduled_at,content_version,ready_revision_id,
   source_type,source_ref,source_revision,source_payload_hash,source_batch_id,imported_at,imported_content_version,
   created_at,updated_at,scheduled_at_utc,schedule_timezone,publication_kind,content_format)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('ready','p1','Ready title','Ready body','READY','APPROVED','MANUAL',null,2,'rev-ready',null,null,null,null,null,null,null,ts,ts,null,null,'FEED','IMAGE');
legacy.prepare(`INSERT INTO posts
  (id,project_id,title,body,status,editorial_stage,schedule_mode,scheduled_at,content_version,ready_revision_id,
   source_type,source_ref,source_revision,source_payload_hash,source_batch_id,imported_at,imported_content_version,
   created_at,updated_at,scheduled_at_utc,schedule_timezone,publication_kind,content_format)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('published','p1','Published title','Published body','PUBLISHED','APPROVED','MANUAL',null,4,'rev-published',null,null,null,null,null,null,null,ts,ts,null,null,'FEED','IMAGE');
legacy.prepare(`INSERT INTO content_revisions
  (id,post_id,content_version,title,body,schedule_mode,scheduled_at,targets_json,media_json,actor_source,created_at,
   scheduled_at_utc,schedule_timezone,publication_kind,content_format,content_media_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('rev-ready','ready',2,'Ready title','Ready body','MANUAL',null,'[]','[]','manual-ready',ts,null,null,'FEED','IMAGE','[]');
legacy.prepare(`INSERT INTO content_revisions
  (id,post_id,content_version,title,body,schedule_mode,scheduled_at,targets_json,media_json,actor_source,created_at,
   scheduled_at_utc,schedule_timezone,publication_kind,content_format,content_media_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('rev-published','published',4,'Published title','Published body','MANUAL',null,'[]','[]','manual-ready',ts,null,null,'FEED','IMAGE','[]');
legacy.pragma('user_version = 8');

const publishedBefore = legacy.prepare('SELECT * FROM posts WHERE id=?').get('published');
legacy.close();

const { db, migrate } = await import('../dist/db.js');
const { DATABASE_SCHEMA_VERSION } = await import('../dist/schema.js');
migrate();
try {
  assert.equal(DATABASE_SCHEMA_VERSION, 9);
  assert.equal(Number(db.pragma('user_version', { simple: true })), 9);

  const columns = new Set(db.prepare('PRAGMA table_info(content_revisions)').all().map((row) => row.name));
  assert.ok(columns.has('editorial_stage'), 'editorial_stage');
  assert.ok(columns.has('restored_from_revision_id'), 'restored_from_revision_id');

  const readyRevision = db.prepare('SELECT id,content_version,title,body,actor_source,editorial_stage,restored_from_revision_id FROM content_revisions WHERE id=?').get('rev-ready');
  assert.deepEqual(readyRevision, {
    id: 'rev-ready',
    content_version: 2,
    title: 'Ready title',
    body: 'Ready body',
    actor_source: 'manual-ready',
    editorial_stage: 'APPROVED',
    restored_from_revision_id: null
  });

  const publishedAfter = db.prepare('SELECT * FROM posts WHERE id=?').get('published');
  assert.deepEqual(publishedAfter, publishedBefore, 'schema 8→9 migration must not mutate historical published post content/state');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_revisions').get().count, 2, 'migration must not fabricate historical gaps');

  migrate();
  assert.equal(Number(db.pragma('user_version', { simple: true })), 9);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_revisions').get().count, 2);
  assert.equal(db.prepare('SELECT editorial_stage FROM content_revisions WHERE id=?').get('rev-published').editorial_stage, 'APPROVED');

  console.log(JSON.stringify({
    ok: true,
    from: 8,
    to: 9,
    revisionHistoryColumns: true,
    existingRevisionsPreserved: true,
    readyRevisionReconciled: true,
    publishedContentPreserved: true,
    historicalGapsNotFabricated: true,
    rerunSafe: true
  }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
