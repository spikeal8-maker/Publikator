import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema-v4-'));
const dbPath = path.join(dataDir, 'publikator.sqlite');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'schema-v4-ci-password';
process.env.APP_MASTER_KEY = 'schema-v4-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const legacy = new Database(dbPath);
legacy.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
  CREATE TABLE social_accounts (id TEXT PRIMARY KEY,platform TEXT NOT NULL,name TEXT NOT NULL,credentials_encrypted TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE posts (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,schedule_mode TEXT NOT NULL,scheduled_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE media (id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,original_name TEXT NOT NULL,relative_path TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,width INTEGER,height INTEGER,sha256 TEXT NOT NULL,created_at TEXT NOT NULL,sort_order INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE post_targets (id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,account_id TEXT NOT NULL REFERENCES social_accounts(id),enabled INTEGER NOT NULL DEFAULT 1,override_text TEXT,state TEXT NOT NULL DEFAULT 'PENDING',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,external_id TEXT,external_url TEXT,last_error TEXT,published_at TEXT,updated_at TEXT NOT NULL,UNIQUE(post_id,account_id));
  INSERT INTO projects VALUES ('p1','Legacy','legacy','2026-01-01T00:00:00.000Z');
  INSERT INTO social_accounts VALUES ('a1','telegram','Legacy TG','encrypted',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
`);legacy.exec(`
  INSERT INTO posts VALUES
    ('ready','p1','Ready legacy','Ready body','READY','MANUAL',NULL,'2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z'),
    ('queued','p1','Queued legacy','Queued body','QUEUED','QUEUE',NULL,'2026-01-03T00:00:00.000Z','2026-01-03T00:00:00.000Z'),
    ('draft','p1','Draft legacy','Draft body','DRAFT','MANUAL',NULL,'2026-01-04T00:00:00.000Z','2026-01-04T00:00:00.000Z'),
    ('published','p1','Published legacy','Published body','PUBLISHED','MANUAL',NULL,'2026-01-05T00:00:00.000Z','2026-01-05T00:00:00.000Z'),
    ('partial','p1','Partial legacy','Partial body','PARTIAL','MANUAL',NULL,'2026-01-06T00:00:00.000Z','2026-01-06T00:00:00.000Z');
  INSERT INTO media VALUES
    ('m-ready','ready','r.jpg','ready/r.jpg','image/jpeg',10,10,10,'${'a'.repeat(64)}','2026-01-02T00:00:00.000Z',0),
    ('m-queued','queued','q.jpg','queued/q.jpg','image/jpeg',10,10,10,'${'b'.repeat(64)}','2026-01-03T00:00:00.000Z',0),
    ('m-published','published','p.jpg','published/p.jpg','image/jpeg',10,10,10,'${'c'.repeat(64)}','2026-01-05T00:00:00.000Z',0),
    ('m-partial','partial','x.jpg','partial/x.jpg','image/jpeg',10,10,10,'${'d'.repeat(64)}','2026-01-06T00:00:00.000Z',0);
  INSERT INTO post_targets VALUES
    ('t-ready','ready','a1',1,NULL,'PENDING',0,NULL,NULL,NULL,NULL,NULL,'2026-01-02T00:00:00.000Z'),
    ('t-queued','queued','a1',1,'Queue override','PENDING',0,NULL,NULL,NULL,NULL,NULL,'2026-01-03T00:00:00.000Z');
  PRAGMA user_version=3;
`);
legacy.close();

const { db, migrate } = await import('../dist/db.js');
migrate();
try {
  assert.equal(Number(db.pragma('user_version', { simple: true })), 4);
  const columns = db.prepare('PRAGMA table_info(posts)').all().map((row) => row.name);
  for (const name of ['editorial_stage','content_version','ready_revision_id']) assert.ok(columns.includes(name), name);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='content_revisions'").get());
  const ready = db.prepare('SELECT status,editorial_stage,content_version,ready_revision_id FROM posts WHERE id=?').get('ready');
  assert.equal(ready.status, 'READY');
  assert.equal(ready.editorial_stage, 'APPROVED');
  assert.equal(ready.content_version, 1);
  assert.ok(ready.ready_revision_id);
  const readyRevision = db.prepare('SELECT * FROM content_revisions WHERE id=?').get(ready.ready_revision_id);
  assert.equal(readyRevision.body, 'Ready body');
  assert.match(readyRevision.media_json, /m-ready/);

  const queued = db.prepare('SELECT status,editorial_stage,content_version,ready_revision_id FROM posts WHERE id=?').get('queued');
  assert.equal(queued.status, 'READY');
  assert.equal(queued.editorial_stage, 'APPROVED');
  assert.equal(queued.content_version, 1);
  assert.ok(queued.ready_revision_id);
  const queuedRevision = db.prepare('SELECT * FROM content_revisions WHERE id=?').get(queued.ready_revision_id);
  assert.match(queuedRevision.targets_json, /Queue override/);

  const draft = db.prepare('SELECT status,editorial_stage,content_version,ready_revision_id FROM posts WHERE id=?').get('draft');
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.editorial_stage, 'DRAFT');
  assert.equal(draft.content_version, 1);
  assert.equal(draft.ready_revision_id, null);

  const published = db.prepare('SELECT status,editorial_stage,ready_revision_id FROM posts WHERE id=?').get('published');
  assert.equal(published.status, 'PUBLISHED');
  assert.equal(published.editorial_stage, 'APPROVED');
  assert.ok(published.ready_revision_id);
  assert.equal(db.prepare('SELECT body FROM content_revisions WHERE id=?').get(published.ready_revision_id).body, 'Published body');

  const partial = db.prepare('SELECT status,editorial_stage,ready_revision_id FROM posts WHERE id=?').get('partial');
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.editorial_stage, 'DRAFT');
  assert.ok(partial.ready_revision_id, 'partial publication history must keep an immutable content snapshot');

  // Re-running migrate on schema 4 must not rewrite editorial state.
  db.prepare("UPDATE posts SET editorial_stage='IN_REVIEW' WHERE id='draft'").run();
  migrate();
  assert.equal(db.prepare("SELECT editorial_stage FROM posts WHERE id='draft'").get().editorial_stage, 'IN_REVIEW');

  console.log(JSON.stringify({ ok: true, from: 3, to: 4, readyRevisionBackfill: true, historicalSnapshotBackfill: true, queuedNormalized: true, rerunSafe: true }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
