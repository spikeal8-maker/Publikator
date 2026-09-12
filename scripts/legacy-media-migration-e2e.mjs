import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-legacy-media-'));
const dbPath = path.join(dataDir, 'publikator.sqlite');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'legacy-media-test-password';
process.env.APP_MASTER_KEY = 'legacy-media-master-key-value-longer-than-thirty-two-characters';

const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE media (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
const insert = legacy.prepare(`INSERT INTO media
  (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
insert.run('old-2','post-old','second.jpg','post-old/second.jpg','image/jpeg',10,20,20,'sha2','2026-01-02T00:00:00.000Z');
insert.run('old-1','post-old','first.jpg','post-old/first.jpg','image/jpeg',10,20,20,'sha1','2026-01-01T00:00:00.000Z');
legacy.close();

const { db, migrate } = await import('../dist/db.js');
try {
  migrate();
  const columns = db.prepare('PRAGMA table_info(media)').all().map((column) => column.name);
  assert.ok(columns.includes('sort_order'));
  const rows = db.prepare('SELECT id,sort_order FROM media WHERE post_id=? ORDER BY sort_order').all('post-old');
  assert.deepEqual(rows, [
    { id: 'old-1', sort_order: 0 },
    { id: 'old-2', sort_order: 1 }
  ]);
  assert.equal(Number(db.pragma('user_version', { simple: true })), 5);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='release_acceptance'").get());
  console.log(JSON.stringify({ ok: true, legacyMediaOrderMigrated: true, schemaVersion: 5 }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
