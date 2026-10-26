import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-backup16-owner-receipts-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = 'schema16-backup-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8080';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { config } = await import('../dist/config.js');
const { DATABASE_SCHEMA_VERSION } = await import('../dist/schema.js');
const { encryptJson, decryptJson } = await import('../dist/crypto.js');
const { createAdminSetupGrant, createOrRecoverAdmin } = await import('../dist/admin-auth.js');
const { createOwnerAgent, controlOwnerAgent } = await import('../dist/agent-owner-registry.js');
const { createBackupBundle, resolveBackupBundle, stageRestoreBundle } =
  await import('../dist/backups.js');
const { applyPendingRestore } = await import('../dist/restore-bootstrap.js');

migrate();
assert.ok(DATABASE_SCHEMA_VERSION >= 16);
createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'),
  'owner', 'schema16-backup-owner-password-2026', 'schema16-backup-owner-password-2026');
const timestamp = nowIso();
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const accountId = id('acc'), postId = id('post');
const credential = { botToken: 'sensitive-test-social-key-not-to-emit', chatId: '@test' };
db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'telegram','Retained channel',?,1,?,?)")
  .run(accountId, encryptJson(credential), timestamp, timestamp);
db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at) VALUES (?,?,'Existing READY','Fixture','READY','APPROVED','MANUAL',?,?)")
  .run(postId, projectId, timestamp, timestamp);
db.prepare("INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (?,?,?,1,'PENDING',0,?)")
  .run(id('target'), postId, accountId, timestamp);

const original = createOwnerAgent({ name: 'Stored bot', clientKind: 'chatgpt' },
  'backup16-create-001');
const paused = controlOwnerAgent(original.agentId, 'pause',
  { expectedGrantVersion: 1, confirm: true }, 'backup16-pause-001');
assert.equal(paused.status, 'PAUSED');

const before = {
  principals: db.prepare('SELECT * FROM agent_principals ORDER BY id').all(),
  grants: db.prepare('SELECT * FROM agent_grants ORDER BY agent_id').all(),
  events: db.prepare('SELECT * FROM agent_activity_events ORDER BY sequence').all(),
  receipts: db.prepare('SELECT * FROM agent_owner_operation_receipts ORDER BY request_id').all(),
  admins: db.prepare('SELECT * FROM admin_users ORDER BY id').all(),
  accounts: db.prepare('SELECT * FROM social_accounts ORDER BY id').all(),
  posts: db.prepare('SELECT * FROM posts ORDER BY id').all(),
  targets: db.prepare('SELECT * FROM post_targets ORDER BY id').all()
};
assert.equal(before.receipts.length, 2);
for (const record of before.receipts) {
  assert.ok(!JSON.stringify(record).includes(credential.botToken));
  assert.ok(!JSON.stringify(record).includes('backup16-create-001'),
    'the raw idempotency key must never be in receipts');
  assert.ok(!JSON.stringify(record).includes(process.env.APP_MASTER_KEY));
}

const bundle = await createBackupBundle('schema16-owner-receipt-evidence');
const archive = resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(archive)).size > 0);

// Mutate everything to prove canonical backup restores both old and new data.
db.prepare('DELETE FROM agent_owner_operation_receipts').run();
db.prepare('DELETE FROM agent_activity_events').run();
db.prepare("UPDATE agent_principals SET status='REVOKED' WHERE id=?").run(original.agentId);
db.prepare("UPDATE agent_grants SET grant_version=9 WHERE agent_id=?").run(original.agentId);
db.prepare("UPDATE posts SET status='DRAFT' WHERE id=?").run(postId);
db.prepare('UPDATE social_accounts SET credentials_encrypted=? WHERE id=?')
  .run(encryptJson({ botToken: 'mutated-test-key' }), accountId);

const staged = await stageRestoreBundle(archive);
assert.equal(staged.manifest.schemaVersion, DATABASE_SCHEMA_VERSION);
db.close();
const result = await applyPendingRestore();
assert.equal(result.applied, true);
const restored = new Database(config.dbPath, { readonly: true, fileMustExist: true });
try {
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(Number(restored.pragma('user_version', { simple: true })), DATABASE_SCHEMA_VERSION);
  for (const [field, table, order] of [
    ['principals','agent_principals','id'],
    ['grants','agent_grants','agent_id'],
    ['events','agent_activity_events','sequence'],
    ['receipts','agent_owner_operation_receipts','request_id'],
    ['admins','admin_users','id'],
    ['accounts','social_accounts','id'],
    ['posts','posts','id'],
    ['targets','post_targets','id']
  ]) {
    assert.deepEqual(restored.prepare('SELECT * FROM ' + table + ' ORDER BY ' + order).all(),
      before[field], 'canonical backup must restore exact ' + table);
  }
  assert.deepEqual(decryptJson(restored.prepare('SELECT credentials_encrypted FROM social_accounts WHERE id=?')
    .get(accountId).credentials_encrypted), credential);
  assert.equal(restored.prepare('SELECT status FROM posts WHERE id=?').get(postId).status, 'READY');
  const receipts = restored.prepare('SELECT operation_id,response_json FROM agent_owner_operation_receipts ORDER BY request_id').all();
  const originalCreate = receipts.find(x => x.operation_id === 'createOwnerAgent');
  const originalPause = receipts.find(x => x.operation_id === 'pauseOwnerAgent');
  assert.deepEqual(JSON.parse(originalCreate.response_json), original);
  assert.deepEqual(JSON.parse(originalPause.response_json), paused);
  assert.deepEqual(restored.pragma('foreign_key_check'), []);
  console.log(JSON.stringify({
    ok: true, checkpoint: 'AGENT-A1b1-schema16', schema: DATABASE_SCHEMA_VERSION,
    immutableReceiptsRestored: true, originalReplayPreserved: true,
    legacyReadyAndEncryptedCredentialsRestored: true, ownerAndAuditRestored: true
  }));
} finally {
  restored.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
