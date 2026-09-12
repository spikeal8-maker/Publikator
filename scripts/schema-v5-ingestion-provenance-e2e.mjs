import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema-v5-'));
const dbPath = path.join(dataDir, 'publikator.sqlite');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'schema-v5-ci-password';
process.env.APP_MASTER_KEY = 'schema-v5-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const legacy = new Database(dbPath);
legacy.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    editorial_stage TEXT NOT NULL DEFAULT 'DRAFT',
    schedule_mode TEXT NOT NULL,
    scheduled_at TEXT,
    content_version INTEGER NOT NULL DEFAULT 1,
    ready_revision_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO projects VALUES ('p1','Schema4','schema4','2026-01-01T00:00:00.000Z');
  INSERT INTO posts VALUES ('post1','p1','Schema4 post','Body','DRAFT','IN_REVIEW','MANUAL',NULL,7,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  PRAGMA user_version=4;
`);
legacy.close();

const { db, migrate } = await import('../dist/db.js');
migrate();
try {
  assert.equal(Number(db.pragma('user_version', { simple: true })), 6);
  const columns = db.prepare('PRAGMA table_info(posts)').all().map((row) => row.name);
  for (const name of ['source_type','source_ref','source_revision','source_payload_hash','source_batch_id','imported_at','imported_content_version']) {
    assert.ok(columns.includes(name), name);
  }
  const preserved = db.prepare('SELECT editorial_stage,content_version FROM posts WHERE id=?').get('post1');
  assert.deepEqual(preserved, { editorial_stage: 'IN_REVIEW', content_version: 7 });

  db.prepare(`UPDATE posts SET source_type='content-plan-v3',source_ref='["sheet","row"]',source_revision='r1',
    source_payload_hash=?,source_batch_id='batch1',imported_at='2026-01-02T00:00:00.000Z',imported_content_version=7 WHERE id='post1'`).run('a'.repeat(64));
  migrate();
  const rerun = db.prepare(`SELECT source_type,source_ref,source_revision,source_payload_hash,source_batch_id,imported_at,imported_content_version,
    editorial_stage,content_version FROM posts WHERE id='post1'`).get();
  assert.deepEqual(rerun, {
    source_type: 'content-plan-v3', source_ref: '["sheet","row"]', source_revision: 'r1', source_payload_hash: 'a'.repeat(64),
    source_batch_id: 'batch1', imported_at: '2026-01-02T00:00:00.000Z', imported_content_version: 7,
    editorial_stage: 'IN_REVIEW', content_version: 7
  });
  console.log(JSON.stringify({ ok: true, from: 4, to: 6, provenanceColumns: true, statePreserved: true, rerunSafe: true }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
