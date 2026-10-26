import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema15-agent-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = 'agent-schema15-master-key-more-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8080';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { DATABASE_SCHEMA_VERSION } = await import('../dist/schema.js');
const { createAdminSetupGrant, createOrRecoverAdmin } = await import('../dist/admin-auth.js');
const { encryptJson, decryptJson } = await import('../dist/crypto.js');

migrate();
try {
  assert.ok(DATABASE_SCHEMA_VERSION >= 15, 'A1a milestone 15 must be included in latest schema');
  const setup = createAdminSetupGrant('INITIAL');
  assert.ok(createOrRecoverAdmin('INITIAL', setup, 'owner',
    'agent-a1a-owner-password-2026', 'agent-a1a-owner-password-2026'));
  const now=nowIso();
  const projectId=db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
  const accountId=id('acc'), postId=id('post');
  const credential={botToken:'test-only-encrypted-telegram',chatId:'@test'};
  const encrypted=encryptJson(credential);
  db.prepare(`INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,'telegram','Retained channel',?,1,?,?)`).run(accountId,encrypted,now,now);
  db.prepare(`INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at)
    VALUES (?,?,'Existing READY','Unpublished fixture','READY','APPROVED','MANUAL',?,?)`)
    .run(postId,projectId,now,now);
  db.prepare(`INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at)
    VALUES (?,?,?,1,'PENDING',0,?)`).run(id('target'),postId,accountId,now);
  const before={
    admins:db.prepare('SELECT * FROM admin_users').all(),
    posts:db.prepare('SELECT * FROM posts').all(),
    socials:db.prepare('SELECT * FROM social_accounts').all(),
    targets:db.prepare('SELECT * FROM post_targets').all()
  };
  // Rehearse a true v14 -> v15 migration, preserving all older data.
  db.exec('DROP TRIGGER IF EXISTS trg_agent_draft_no_external_publish; DROP TABLE IF EXISTS agent_operation_receipts; DROP TABLE IF EXISTS agent_draft_ownership; DROP TABLE agent_machine_keys; DROP TABLE agent_owner_operation_receipts; DROP TABLE agent_activity_events; DROP TABLE agent_grants; DROP TABLE agent_principals;');
  db.pragma('user_version = 14');
  migrate();
  assert.equal(Number(db.pragma('user_version',{simple:true})),DATABASE_SCHEMA_VERSION);
  for(const table of ['agent_principals','agent_grants','agent_activity_events']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,
      'upgrading existing installation must not invent agents: '+table);
  }
  assert.deepEqual(db.prepare('SELECT * FROM admin_users').all(),before.admins);
  assert.deepEqual(db.prepare('SELECT * FROM posts').all(),before.posts);
  assert.deepEqual(db.prepare('SELECT * FROM social_accounts').all(),before.socials);
  assert.deepEqual(db.prepare('SELECT * FROM post_targets').all(),before.targets);
  assert.deepEqual(decryptJson(encrypted),credential);

  const agentId='agent_a1a_001';
  db.prepare(`INSERT INTO agent_principals(id,owner_admin_id,name,client_kind,created_at,updated_at)
    VALUES (?,'owner','Bot without privileges','chatgpt',?,?)`).run(agentId,now,now);
  db.prepare('INSERT INTO agent_grants(agent_id,created_at,updated_at) VALUES (?,?,?)')
    .run(agentId,now,now);
  const grant=db.prepare('SELECT * FROM agent_grants WHERE agent_id=?').get(agentId);
  assert.equal(grant.preset_id,'OBSERVER');
  assert.equal(grant.preset_version,1);
  assert.equal(grant.grant_version,1);
  assert.equal(grant.publish_mode,'DRAFT_ONLY');
  assert.equal(grant.preapproved_policy_json,null);
  for(const name of ['scope_ids_json','project_ids_json','account_ids_json','source_connector_ids_json'])
    assert.deepEqual(JSON.parse(grant[name]),[],name+' must not grant new resources');
  assert.throws(() => db.prepare('UPDATE agent_grants SET publish_mode=? WHERE agent_id=?')
    .run('PREAPPROVED_POLICY',agentId),/CHECK constraint/);

  const attemptAuto=db.prepare('UPDATE agent_grants SET publish_mode=?,preapproved_policy_json=? WHERE agent_id=?');
  for(const invalid of [
    '{}',
    '{"approvedPolicyVersion":null}',
    '{"approvedPolicyVersion":0}',
    '{"approvedPolicyVersion":-2}',
    '{"approvedPolicyVersion":"2"}',
    '{"approvedPolicyVersion":1.5}'
  ]) {
    assert.throws(() => attemptAuto.run('PREAPPROVED_POLICY',invalid,agentId),
      /CHECK constraint/, 'auto grants require a positive integer owner policy version: '+invalid);
  }
  assert.equal(db.prepare('SELECT publish_mode FROM agent_grants WHERE agent_id=?')
    .get(agentId).publish_mode,'DRAFT_ONLY','invalid auto attempts must not elevate permission');
  attemptAuto.run('PREAPPROVED_POLICY',JSON.stringify({approvedPolicyVersion:1}),agentId);
  assert.equal(db.prepare('SELECT publish_mode FROM agent_grants WHERE agent_id=?')
    .get(agentId).publish_mode,'PREAPPROVED_POLICY');
  db.prepare("UPDATE agent_grants SET publish_mode='DRAFT_ONLY',preapproved_policy_json=NULL WHERE agent_id=?")
    .run(agentId);

  assert.throws(() => db.prepare("UPDATE agent_grants SET scope_ids_json='untrusted' WHERE agent_id=?")
    .run(agentId),/CHECK constraint/);
  assert.throws(() => db.prepare(`INSERT INTO agent_principals(id,owner_admin_id,name,client_kind,created_at,updated_at)
    VALUES (?,'someone_else','Wrong owner','chatgpt',?,?)`)
    .run('agent_wrong',now,now),/CHECK constraint|FOREIGN KEY constraint/);
  assert.throws(() => db.prepare('UPDATE agent_principals SET status=? WHERE id=?')
    .run('ADMINISTRATOR',agentId),/CHECK constraint/);

  const insert=db.prepare(`INSERT INTO agent_activity_events(
    event_id,agent_id,actor_type,origin,request_id,operation_id,stage,outcome,safe_summary,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insert.run('evt_a1a_001',agentId,'AGENT','REST','request_a1a_001',
    'agent.grant.read','COMPLETED','SUCCEEDED','Разрешения просмотрены',now);
  const event=db.prepare('SELECT * FROM agent_activity_events WHERE event_id=?').get('evt_a1a_001');
  assert.equal(event.safe_summary,'Разрешения просмотрены');
  assert.deepEqual(JSON.parse(event.target_account_ids_json),[]);
  assert.throws(() => insert.run('evt_a1a_bad',agentId,'AGENT','REST','req_002',
    'agent.grant.read','COMPLETED','SUCCEEDED','x'.repeat(241),now),/CHECK constraint/);
  assert.throws(() => db.prepare(`INSERT INTO agent_activity_events(
    event_id,agent_id,actor_type,origin,request_id,operation_id,stage,safe_summary,occurred_at)
    VALUES (?,?,'AGENT','REST','req_003','media.import','PROGRESS','No job',?)`)
    .run('evt_bad_progress',agentId,now),/CHECK constraint/);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);

  const snapshot={
    principal:db.prepare('SELECT * FROM agent_principals WHERE id=?').get(agentId),
    grant:db.prepare('SELECT * FROM agent_grants WHERE agent_id=?').get(agentId),
    event:db.prepare('SELECT * FROM agent_activity_events WHERE event_id=?').get('evt_a1a_001')
  };
  migrate();
  assert.deepEqual(db.prepare('SELECT * FROM agent_principals WHERE id=?').get(agentId),snapshot.principal);
  assert.deepEqual(db.prepare('SELECT * FROM agent_grants WHERE agent_id=?').get(agentId),snapshot.grant);
  assert.deepEqual(db.prepare('SELECT * FROM agent_activity_events WHERE event_id=?').get('evt_a1a_001'),snapshot.event);
  db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION+1}`);
  assert.throws(()=>migrate(),new RegExp(`новее поддерживаемой ${DATABASE_SCHEMA_VERSION}`));
  db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A1a',from:14,to:15,
    defaultDeny:true,legacyReadyAndCredentialsPreserved:true,boundedAudit:true,
    rerunSafe:true,futureSchemaRefused:true}));
} finally {
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
