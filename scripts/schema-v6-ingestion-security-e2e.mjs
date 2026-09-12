import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema-v6-'));
const dbPath = path.join(dataDir, 'publikator.sqlite');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'schema-v6-ci-password';
process.env.APP_MASTER_KEY = 'schema-v6-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const legacy = new Database(dbPath);
legacy.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
  CREATE TABLE posts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL, editorial_stage TEXT NOT NULL, schedule_mode TEXT NOT NULL, scheduled_at TEXT,
    content_version INTEGER NOT NULL, ready_revision_id TEXT, source_type TEXT, source_ref TEXT,
    source_revision TEXT, source_payload_hash TEXT, source_batch_id TEXT, imported_at TEXT,
    imported_content_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  INSERT INTO projects VALUES ('p1','Schema5','schema5','2026-01-01T00:00:00.000Z');
`);legacy.exec(`
  INSERT INTO posts VALUES (
    'post1','p1','Schema5 post','Body','DRAFT','IN_REVIEW','MANUAL',NULL,7,NULL,
    'content-plan-v3','["sheet","row"]','rev-7','${'a'.repeat(64)}','batch-7','2026-01-02T00:00:00.000Z',7,
    '2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z'
  );
  PRAGMA user_version=5;
`);
legacy.close();

const { db, migrate } = await import('../dist/db.js');
migrate();
try {
  assert.equal(Number(db.pragma('user_version', { simple: true })), 6);
  for (const table of ['integration_api_keys', 'ingestion_connectors']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  }
  const preserved = db.prepare(`SELECT editorial_stage,content_version,source_type,source_ref,source_revision,
    source_payload_hash,source_batch_id,imported_at,imported_content_version FROM posts WHERE id='post1'`).get();
  assert.deepEqual(preserved, {
    editorial_stage: 'IN_REVIEW', content_version: 7, source_type: 'content-plan-v3', source_ref: '["sheet","row"]',
    source_revision: 'rev-7', source_payload_hash: 'a'.repeat(64), source_batch_id: 'batch-7',
    imported_at: '2026-01-02T00:00:00.000Z', imported_content_version: 7
  });  migrate();
  assert.equal(Number(db.pragma('user_version', { simple: true })), 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM integration_api_keys').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingestion_connectors').get().n, 0);
  console.log(JSON.stringify({
    ok: true,
    from: 5,
    to: 6,
    securityTables: true,
    existingContentPreserved: true,
    rerunSafe: true
  }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
