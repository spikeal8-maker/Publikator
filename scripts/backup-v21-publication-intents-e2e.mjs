import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-publication-intent-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: directory, PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
  APP_MASTER_KEY: 'publication-intent-test-key-longer-than-thirty-two-characters',
});
delete process.env.ADMIN_PASSWORD;

const { db, migrate } = await import('../dist/db.js');
const { requestAgentPublication } = await import('../dist/agent-publication-intent.js');
const { seedAgentPublicationDraft } = await import('./fixtures/agent-publication-intent-fixture.mjs');

const { default: Database } = await import('better-sqlite3');
const { config } = await import('../dist/config.js');
const { createBackupBundle, resolveBackupBundle, stageRestoreBundle } = await import('../dist/backups.js');
const { applyPendingRestore } = await import('../dist/restore-bootstrap.js');
let restored;
try {
  migrate();
  const fixture = seedAgentPublicationDraft(db);
  const intent = requestAgentPublication(fixture.identity, fixture.input);
  const before = db.prepare('SELECT * FROM agent_publication_intents WHERE id=?').get(intent.intentId);
  assert.ok(!JSON.stringify(before).includes('test-provider-token'));
  const bundle = await createBackupBundle('agent-publication-intent');
  const staged = await stageRestoreBundle(resolveBackupBundle(bundle.name));
  assert.equal(staged.manifest.schemaVersion, 21);
  db.close();
  assert.equal((await applyPendingRestore()).applied, true);
  restored = new Database(config.dbPath, { fileMustExist: true });
  assert.deepEqual(restored.prepare('SELECT * FROM agent_publication_intents WHERE id=?').get(intent.intentId), before);
  assert.equal(restored.prepare('SELECT status FROM posts WHERE id=?').get(intent.postId).status, 'DRAFT');
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  console.log('Schema 21 canonical backup and restore preserve a non-executable publication intent PASS');
} finally {
  if (restored) restored.close();
  if (db.open) db.close();
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
