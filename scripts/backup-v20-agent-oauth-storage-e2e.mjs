import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-oauth-storage-backup-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.APP_MASTER_KEY = 'oauth-storage-backup-fixture-key-long-enough';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8080';
delete process.env.ADMIN_PASSWORD;

const { db, migrate } = await import('../dist/db.js');
const { config } = await import('../dist/config.js');
const { createSQLiteOAuthAdapter } = await import('../dist/agent-oauth-adapter.js');
const { createBackupBundle, resolveBackupBundle, stageRestoreBundle } = await import('../dist/backups.js');
const { applyPendingRestore } = await import('../dist/restore-bootstrap.js');
let restored;

try {
  migrate();
  const token = 'synthetic-refresh-token-never-stored-as-plaintext';
  const payload = { grantId: 'synthetic-grant', subject: 'fixture-owner' };
  const adapter = createSQLiteOAuthAdapter(db)('RefreshToken');
  await adapter.upsert(token, payload, 300);
  await adapter.consume(token);
  const before = await adapter.find(token);
  const beforeRow = db.prepare('SELECT * FROM agent_oauth_artifacts').get();
  assert.equal(JSON.stringify(beforeRow).includes(token), false);

  const bundle = await createBackupBundle('oauth-storage-fixture');
  await adapter.destroy(token);
  const staged = await stageRestoreBundle(resolveBackupBundle(bundle.name));
  assert.equal(staged.manifest.schemaVersion, db.pragma('user_version', { simple: true }));
  db.close();
  assert.equal((await applyPendingRestore()).applied, true);

  restored = new Database(config.dbPath, { fileMustExist: true });
  assert.deepEqual(restored.prepare('SELECT * FROM agent_oauth_artifacts').get(), beforeRow);
  const recovered = createSQLiteOAuthAdapter(restored)('RefreshToken');
  assert.deepEqual(await recovered.find(token), before);
  await assert.rejects(recovered.consume(token), /no longer available/);
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  console.log('Canonical OAuth storage backup/restore keeps ciphertext and original consumption state PASS');
} finally {
  if (restored) restored.close();
  if (db.open) db.close();
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
