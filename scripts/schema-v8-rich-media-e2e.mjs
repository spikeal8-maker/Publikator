import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema-v8-'));
const dbPath = path.join(dataDir, 'publikator.sqlite');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'schema-v8-ci-password';
process.env.APP_MASTER_KEY = 'schema-v8-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const legacy = new Database(dbPath);
legacy.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
CREATE TABLE social_accounts(id TEXT PRIMARY KEY,platform TEXT NOT NULL,name TEXT NOT NULL,credentials_encrypted TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE posts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,editorial_stage TEXT NOT NULL,schedule_mode TEXT NOT NULL,scheduled_at TEXT,content_version INTEGER NOT NULL,ready_revision_id TEXT,source_type TEXT,source_ref TEXT,source_revision TEXT,source_payload_hash TEXT,source_batch_id TEXT,imported_at TEXT,imported_content_version INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,scheduled_at_utc TEXT,schedule_timezone TEXT,publication_kind TEXT NOT NULL DEFAULT 'FEED',content_format TEXT NOT NULL DEFAULT 'IMAGE');
CREATE TABLE content_revisions(id TEXT PRIMARY KEY,post_id TEXT NOT NULL,content_version INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,schedule_mode TEXT NOT NULL,scheduled_at TEXT,targets_json TEXT NOT NULL,media_json TEXT NOT NULL,actor_source TEXT NOT NULL,created_at TEXT NOT NULL,scheduled_at_utc TEXT,schedule_timezone TEXT,publication_kind TEXT NOT NULL DEFAULT 'FEED',content_format TEXT NOT NULL DEFAULT 'IMAGE',UNIQUE(post_id,content_version));
CREATE TABLE media(id TEXT PRIMARY KEY,post_id TEXT NOT NULL,original_name TEXT NOT NULL,relative_path TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,width INTEGER,height INTEGER,sha256 TEXT NOT NULL,created_at TEXT NOT NULL,sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE integration_api_keys(id TEXT PRIMARY KEY,name TEXT NOT NULL,prefix TEXT NOT NULL,key_hash TEXT NOT NULL UNIQUE,scopes_json TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL,last_used_at TEXT,rotated_from_id TEXT);
CREATE TABLE ingestion_connectors(id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,config_json TEXT NOT NULL,credentials_encrypted TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE target_renditions(target_id TEXT PRIMARY KEY,text_rich_json TEXT,text_plain TEXT,publication_kind TEXT,content_format TEXT,media_plan_json TEXT,options_json TEXT,updated_at TEXT NOT NULL);
CREATE TABLE publication_units(id TEXT PRIMARY KEY,target_id TEXT NOT NULL,revision_id TEXT NOT NULL,unit_index INTEGER NOT NULL,unit_type TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,external_id TEXT,external_url TEXT,last_error TEXT,published_at TEXT,updated_at TEXT NOT NULL);
`);
legacy.exec(`INSERT INTO projects VALUES('p1','Schema7','schema7','2026-01-01T00:00:00.000Z');
INSERT INTO posts VALUES('image','p1','Image','Body','DRAFT','DRAFT','MANUAL',NULL,1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL,NULL,'FEED','CAROUSEL');
INSERT INTO media VALUES('img1','image','1.jpg','image/1.jpg','image/jpeg',10,1200,630,'${'a'.repeat(64)}','2026-01-01T00:00:00.000Z',0);
INSERT INTO media VALUES('img2','image','2.jpg','image/2.jpg','image/jpeg',10,1200,630,'${'b'.repeat(64)}','2026-01-01T00:00:00.000Z',1);
INSERT INTO content_revisions VALUES('rev-image','image',1,'Image','Body','MANUAL',NULL,'[]','[{"id":"img1","sort_order":0},{"id":"img2","sort_order":1}]','fixture','2026-01-01T00:00:00.000Z',NULL,NULL,'FEED','CAROUSEL');
INSERT INTO posts VALUES('story','p1','Story','Body','DRAFT','DRAFT','MANUAL',NULL,1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL,NULL,'STORY','STORY_SEQUENCE');
INSERT INTO media VALUES('story1','story','story.jpg','story/story.jpg','image/jpeg',10,1080,1920,'${'c'.repeat(64)}','2026-01-01T00:00:00.000Z',0);
INSERT INTO content_revisions VALUES('rev-story','story',1,'Story','Body','MANUAL',NULL,'[]','[{"id":"story1","sort_order":0}]','fixture','2026-01-01T00:00:00.000Z',NULL,NULL,'STORY','STORY_SEQUENCE');
PRAGMA user_version=7;`);
legacy.close();

const { db, migrate, nowIso } = await import('../dist/db.js');
migrate();
try {
  assert.equal(Number(db.pragma('user_version', { simple: true })), 11);
  const mediaColumns = new Set(db.prepare('PRAGMA table_info(media)').all().map((row) => row.name));
  for (const column of ['duration_ms','fps','video_codec','audio_codec','container','poster_asset_id']) assert.ok(mediaColumns.has(column), column);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='content_media'").get());
  const imageRoles = db.prepare("SELECT media_id,role,sort_order FROM content_media WHERE post_id='image' ORDER BY sort_order").all();
  assert.deepEqual(imageRoles, [
    { media_id: 'img1', role: 'carousel_item', sort_order: 0 },
    { media_id: 'img2', role: 'carousel_item', sort_order: 1 }
  ]);
  const storyRoles = db.prepare("SELECT media_id,role,sort_order FROM content_media WHERE post_id='story'").all();
  assert.deepEqual(storyRoles, [{ media_id: 'story1', role: 'story_item', sort_order: 0 }]);
  const revImage = JSON.parse(db.prepare("SELECT content_media_json FROM content_revisions WHERE id='rev-image'").get().content_media_json);
  assert.deepEqual(revImage.map(({ mediaId, sortOrder, role }) => ({ mediaId, sortOrder, role })), [
    { mediaId: 'img1', sortOrder: 0, role: 'carousel_item' },
    { mediaId: 'img2', sortOrder: 1, role: 'carousel_item' }
  ]);
  const revStory = JSON.parse(db.prepare("SELECT content_media_json FROM content_revisions WHERE id='rev-story'").get().content_media_json);
  assert.equal(revStory[0].role, 'story_item');

  db.prepare(`INSERT INTO media(id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
    VALUES ('img3','image','3.jpg','image/3.jpg','image/jpeg',10,1200,630,?, ?,2)`).run('d'.repeat(64), nowIso());
  assert.equal(db.prepare("SELECT role FROM content_media WHERE media_id='img3'").get().role, 'carousel_item');
  db.prepare("UPDATE media SET sort_order=7 WHERE id='img3'").run();
  assert.equal(db.prepare("SELECT sort_order FROM content_media WHERE media_id='img3'").get().sort_order, 7);
  assert.throws(() => db.prepare(`INSERT INTO content_media(id,post_id,media_id,sort_order,role,created_at,updated_at)
    VALUES ('bad','story','img1',0,'story_item',?,?)`).run(nowIso(), nowIso()), /same post/);

  migrate();
  assert.equal(Number(db.pragma('user_version', { simple: true })), 11);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_media WHERE post_id='image'").get().n, 3);
  console.log(JSON.stringify({
    ok: true, from: 7, to: 9, videoMetadataColumns: true, contentMediaBackfill: true,
    immutableRelationBackfill: true, imageCompatibilityTriggers: true, samePostGuard: true, rerunSafe: true
  }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
