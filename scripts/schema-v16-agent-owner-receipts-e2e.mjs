import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema16-owner-receipts-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = 'schema16-owner-receipt-master-key-long-enough-2026';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8080';

const { db, migrate, nowIso, id } = await import('../dist/db.js');
const { DATABASE_SCHEMA_VERSION } = await import('../dist/schema.js');
const { createAdminSetupGrant, createOrRecoverAdmin } = await import('../dist/admin-auth.js');
const { createOwnerAgent, controlOwnerAgent } = await import('../dist/agent-owner-registry.js');

migrate();
try {
  assert.ok(DATABASE_SCHEMA_VERSION >= 16);
  createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'),
    'owner', 'schema16-owner-password-2026', 'schema16-owner-password-2026');
  const now = nowIso();
  const agent = id('agent');
  db.prepare("INSERT INTO agent_principals(id,owner_admin_id,name,client_kind,created_at,updated_at) VALUES (?,'owner','Legacy agent','rest_client',?,?)")
    .run(agent, now, now);
  db.prepare('INSERT INTO agent_grants(agent_id,created_at,updated_at) VALUES (?,?,?)')
    .run(agent, now, now);
  db.prepare("INSERT INTO agent_activity_events(event_id,agent_id,actor_type,origin,request_id,operation_id,stage,outcome,safe_summary,occurred_at) VALUES (?,?,'OWNER','UI','req_preexisting','createOwnerAgent','COMPLETED','SUCCEEDED','До схемы 16',?)")
    .run(id('evt'), agent, now);
  const before = {
    agent: db.prepare('SELECT * FROM agent_principals WHERE id=?').get(agent),
    grant: db.prepare('SELECT * FROM agent_grants WHERE agent_id=?').get(agent),
    events: db.prepare('SELECT * FROM agent_activity_events ORDER BY sequence').all(),
    admin: db.prepare('SELECT * FROM admin_users').all()
  };

  // Simulate a real N-1 schema 15 database: principals/grants/audit exist.
  db.exec('DROP TABLE agent_machine_keys; DROP TABLE agent_owner_operation_receipts;');
  db.pragma('user_version = 15');
  migrate();
  assert.equal(Number(db.pragma('user_version', { simple: true })), DATABASE_SCHEMA_VERSION);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_owner_operation_receipts'").get());
  assert.equal(db.prepare('SELECT count(*) AS n FROM agent_owner_operation_receipts').get().n, 0);
  assert.deepEqual(db.prepare('SELECT * FROM agent_principals WHERE id=?').get(agent), before.agent);
  assert.deepEqual(db.prepare('SELECT * FROM agent_grants WHERE agent_id=?').get(agent), before.grant);
  assert.deepEqual(db.prepare('SELECT * FROM agent_activity_events ORDER BY sequence').all(), before.events);
  assert.deepEqual(db.prepare('SELECT * FROM admin_users').all(), before.admin);

  const first = createOwnerAgent({ name: 'Agent for exact response proof', clientKind: 'n8n' },
    'schema16-create-001');
  const paused = controlOwnerAgent(first.agentId, 'pause',
    { expectedGrantVersion: 1, confirm: true }, 'schema16-pause-001');
  assert.equal(paused.status, 'PAUSED');
  assert.equal(paused.grantVersion, 2);
  const revoked = controlOwnerAgent(first.agentId, 'revoke',
    { expectedGrantVersion: 2, confirm: true }, 'schema16-revoke-001');
  assert.equal(revoked.status, 'REVOKED');
  assert.equal(revoked.grantVersion, 3);
  // Reply must be the exact *original* immutable response, not the current state.
  assert.deepEqual(controlOwnerAgent(first.agentId, 'pause',
    { confirm: true, expectedGrantVersion: 1 }, 'schema16-pause-001'), paused);
  assert.deepEqual(createOwnerAgent({ clientKind: 'n8n', name: 'Agent for exact response proof' },
    'schema16-create-001'), first);
  assert.equal(db.prepare('SELECT count(*) AS n FROM agent_owner_operation_receipts').get().n, 3);
  assert.throws(() => createOwnerAgent({
    name: 'Other content', clientKind: 'n8n'
  }, 'schema16-create-001'), /Ключ уже использован/);

  const receipt = db.prepare('SELECT * FROM agent_owner_operation_receipts ORDER BY request_id').all();
  assert.ok(receipt.every(r => !JSON.stringify(r).includes('schema16-create-001')));
  assert.ok(receipt.every(r => !JSON.stringify(r).includes(process.env.APP_MASTER_KEY)));
  assert.ok(receipt.every(r => JSON.parse(r.response_json).grant || JSON.parse(r.response_json).grantVersion));

  const insert = db.prepare('INSERT INTO agent_owner_operation_receipts(request_id,agent_id,operation_id,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?)');
  assert.throws(() => insert.run('req_bad_json', first.agentId, 'pauseOwnerAgent',
    'a'.repeat(64), '{"truncated":', now), /CHECK constraint/);
  assert.throws(() => insert.run('req_missing_fk', 'agent_missing', 'pauseOwnerAgent',
    'a'.repeat(64), '{"grantVersion":1}', now), /FOREIGN KEY constraint/);
  assert.throws(() => insert.run('req_too_big', first.agentId, 'pauseOwnerAgent',
    'a'.repeat(64), JSON.stringify({ value: 'a'.repeat(70000) }), now), /CHECK constraint/);

  const snapshot = db.prepare('SELECT * FROM agent_owner_operation_receipts ORDER BY request_id').all();
  migrate();
  assert.deepEqual(db.prepare('SELECT * FROM agent_owner_operation_receipts ORDER BY request_id').all(), snapshot,
    're-running latest migration cannot alter immutable receipts');
  db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION+1}`);
  assert.throws(() => migrate(),new RegExp(`новее поддерживаемой ${DATABASE_SCHEMA_VERSION}`));
  db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  console.log(JSON.stringify({
    ok: true, checkpoint: 'AGENT-A1b1-schema16', from: 15, to: 16,
    oldAgentsPreserved: true, exactReplayAfterRevoke: true, jsonOrderIndependent: true,
    unsafeReceiptRefused: true, noSecrets: true, rerunSafe: true, newerSchemaRefused: true
  }));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
