import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema-v7-'));
const dbPath = path.join(dataDir, 'publikator.sqlite');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'schema-v7-ci-password';
process.env.APP_MASTER_KEY = 'schema-v7-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const legacy = new Database(dbPath);
legacy.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
CREATE TABLE social_accounts(id TEXT PRIMARY KEY,platform TEXT NOT NULL,name TEXT NOT NULL,credentials_encrypted TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE posts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,editorial_stage TEXT NOT NULL,schedule_mode TEXT NOT NULL,scheduled_at TEXT,content_version INTEGER NOT NULL,ready_revision_id TEXT,source_type TEXT,source_ref TEXT,source_revision TEXT,source_payload_hash TEXT,source_batch_id TEXT,imported_at TEXT,imported_content_version INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE content_revisions(id TEXT PRIMARY KEY,post_id TEXT NOT NULL,content_version INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,schedule_mode TEXT NOT NULL,scheduled_at TEXT,targets_json TEXT NOT NULL,media_json TEXT NOT NULL,actor_source TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(post_id,content_version));
CREATE TABLE integration_api_keys(id TEXT PRIMARY KEY,name TEXT NOT NULL,prefix TEXT NOT NULL,key_hash TEXT NOT NULL UNIQUE,scopes_json TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL,last_used_at TEXT,rotated_from_id TEXT);
CREATE TABLE ingestion_connectors(id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,config_json TEXT NOT NULL,credentials_encrypted TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
`);
legacy.exec(`CREATE TABLE post_targets(id TEXT PRIMARY KEY,post_id TEXT NOT NULL,account_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,override_text TEXT,state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PUBLISHING','PUBLISHED','RETRY','FAILED','RECOVERY_NEEDED')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,external_id TEXT,external_url TEXT,last_error TEXT,published_at TEXT,updated_at TEXT NOT NULL,UNIQUE(post_id,account_id));
CREATE TABLE media(id TEXT PRIMARY KEY,post_id TEXT NOT NULL,original_name TEXT NOT NULL,relative_path TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,width INTEGER,height INTEGER,sha256 TEXT NOT NULL,created_at TEXT NOT NULL,sort_order INTEGER NOT NULL DEFAULT 0);
INSERT INTO projects VALUES('p1','Schema6','schema6','2026-01-01T00:00:00.000Z');
INSERT INTO social_accounts VALUES('a1','telegram','Main','enc',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT INTO posts VALUES('post1','p1','AT post','Body','READY','APPROVED','AT','2026-01-02T10:00:00.000Z',4,'rev1',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT INTO post_targets VALUES('t1','post1','a1',1,NULL,'PENDING',0,NULL,NULL,NULL,NULL,NULL,'2026-01-01T00:00:00.000Z');
INSERT INTO media VALUES('m1','post1','1.jpg','post1/1.jpg','image/jpeg',1,1,1,'${'a'.repeat(64)}','2026-01-01T00:00:00.000Z',0);
INSERT INTO media VALUES('m2','post1','2.jpg','post1/2.jpg','image/jpeg',1,1,1,'${'b'.repeat(64)}','2026-01-01T00:00:00.000Z',1);
INSERT INTO content_revisions VALUES('rev1','post1',4,'AT post','Body','AT','2026-01-02T10:00:00.000Z','[{"targetId":"t1","accountId":"a1","enabled":true,"overrideText":null}]','[{},{}]','fixture','2026-01-01T00:00:00.000Z');
PRAGMA user_version=6;`);
legacy.close();

const { db, migrate } = await import('../dist/db.js');
migrate();
try {
  assert.equal(Number(db.pragma('user_version', { simple: true })), 9);
  const post = db.prepare(`SELECT scheduled_at_utc,schedule_timezone,publication_kind,content_format
    FROM posts WHERE id='post1'`).get();
  assert.deepEqual(post, {
    scheduled_at_utc: '2026-01-02T10:00:00.000Z', schedule_timezone: 'UTC',
    publication_kind: 'FEED', content_format: 'CAROUSEL'
  });
  const revision = db.prepare(`SELECT scheduled_at_utc,schedule_timezone,publication_kind,content_format
    FROM content_revisions WHERE id='rev1'`).get();
  assert.deepEqual(revision, {
    scheduled_at_utc: '2026-01-02T10:00:00.000Z', schedule_timezone: 'UTC',
    publication_kind: 'FEED', content_format: 'CAROUSEL'
  });
  const revisionTargets = JSON.parse(db.prepare("SELECT targets_json FROM content_revisions WHERE id='rev1'").get().targets_json);
  assert.equal(revisionTargets[0].rendition, null);
  const targetSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='post_targets'").get().sql);
  assert.match(targetSql, /PARTIAL/);
  for (const table of ['target_renditions','publication_units']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  }
  migrate();
  assert.equal(Number(db.pragma('user_version', { simple: true })), 9);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM publication_units").get().n, 0);
  console.log(JSON.stringify({
    ok: true, from: 6, to: 9, utcBackfill: true, timezoneFallback: 'UTC',
    renditionTables: true, legacyRenditionSnapshotNormalized: true, targetPartialState: true, legacyCarouselProjection: true, rerunSafe: true
  }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
