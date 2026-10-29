import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-schema17-machine-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='schema17-test-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='http://127.0.0.1:8080';

const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {DATABASE_SCHEMA_VERSION}=await import('../dist/schema.js');
const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');
const {
  issueOwnerMachineKey,revokeOwnerMachineKey,authenticateAgentMachineKey,
  listOwnerMachineKeys
}=await import('../dist/agent-machine-keys.js');
const {encryptJson,decryptJson}=await import('../dist/crypto.js');
migrate();
try{
  assert.equal(DATABASE_SCHEMA_VERSION,17);
  createOrRecoverAdmin('INITIAL',createAdminSetupGrant('INITIAL'),'owner',
    'schema17-admin-password-2026','schema17-admin-password-2026');
  const projectId=db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  const now=nowIso(),acc=id('acc'),post=id('post'),agent=id('agent');
  const secret={botToken:'schema17-existing-provider-private-credential',chatId:'@safe'};
  const encrypted=encryptJson(secret);
  db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'telegram','Retained account',?,1,?,?)").run(acc,encrypted,now,now);
  db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at) VALUES (?,?,?,'existing','READY','APPROVED','MANUAL',?,?)").run(post,projectId,'Keep ready',now,now);
  db.prepare("INSERT INTO agent_principals(id,owner_admin_id,name,client_kind,created_at,updated_at) VALUES (?,'owner','Existing n8n','n8n',?,?)").run(agent,now,now);
  db.prepare("INSERT INTO agent_grants(agent_id,preset_id,scope_ids_json,project_ids_json,created_at,updated_at) VALUES (?,'CUSTOM','[\"projects:read\"]',?,?,?)").run(agent,JSON.stringify([projectId]),now,now);
  const before={
    agents:db.prepare('SELECT * FROM agent_principals ORDER BY id').all(),
    grants:db.prepare('SELECT * FROM agent_grants ORDER BY agent_id').all(),
    admins:db.prepare('SELECT * FROM admin_users ORDER BY id').all(),
    accounts:db.prepare('SELECT * FROM social_accounts ORDER BY id').all(),
    posts:db.prepare('SELECT * FROM posts ORDER BY id').all()
  };
  db.exec('DROP TABLE agent_machine_keys');
  db.pragma('user_version = 16');
  migrate();
  assert.equal(Number(db.pragma('user_version',{simple:true})),17);
  for(const [key,table,order] of [
    ['agents','agent_principals','id'],['grants','agent_grants','agent_id'],
    ['admins','admin_users','id'],['accounts','social_accounts','id'],['posts','posts','id']
  ]){
    assert.deepEqual(db.prepare('SELECT * FROM '+table+' ORDER BY '+order).all(),before[key]);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_machine_keys').get().n,0,
    'migration must not issue any machine credentials');
  assert.deepEqual(decryptJson(encrypted),secret);
  const issued=issueOwnerMachineKey(agent,{
    expectedGrantVersion:1,scopeIds:['projects:read'],ttlHours:24
  },'schema17-issue-first');
  assert.match(issued.bearerToken,/^pak1_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.secretAvailable,true);
  assert.equal(authenticateAgentMachineKey(issued.bearerToken).agentId,agent);
  const replay=issueOwnerMachineKey(agent,{
    ttlHours:24,scopeIds:['projects:read'],expectedGrantVersion:1
  },'schema17-issue-first');
  assert.equal(replay.bearerToken,null);
  assert.equal(replay.secretAvailable,false);
  assert.deepEqual(replay.machineKey,issued.machineKey);
  assert.equal(listOwnerMachineKeys(agent).items.length,1);
  const stored=db.prepare('SELECT * FROM agent_machine_keys').get();
  assert.equal(stored.token_hash.length,64);
  assert.ok(!JSON.stringify(stored).includes(issued.bearerToken));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM agent_owner_operation_receipts').all())
    .includes(issued.bearerToken));
  assert.throws(()=>authenticateAgentMachineKey(process.env.APP_MASTER_KEY),{code:'UNAUTHORIZED'});
  assert.throws(()=>authenticateAgentMachineKey('pk_a_rejected_legacy_key'),{code:'UNAUTHORIZED'});
  assert.throws(()=>authenticateAgentMachineKey('pak1_'+'x'.repeat(43)),{code:'UNAUTHORIZED'});
  assert.throws(()=>issueOwnerMachineKey(agent,{
    expectedGrantVersion:1,scopeIds:['publish:request'],ttlHours:24
  },'schema17-not-publish'),{code:'POLICY_DENIED'});
  assert.throws(()=>issueOwnerMachineKey(agent,{
    expectedGrantVersion:1,scopeIds:['projects:read'],ttlHours:721
  },'schema17-not-forever'),{code:'VALIDATION_ERROR'});
  const revoked=revokeOwnerMachineKey(agent,issued.machineKey.keyId,
    {confirm:true},'schema17-revoke');
  assert.ok(revoked.revokedAt);
  assert.throws(()=>authenticateAgentMachineKey(issued.bearerToken),{code:'UNAUTHORIZED'});
  assert.deepEqual(revokeOwnerMachineKey(agent,issued.machineKey.keyId,
    {confirm:true},'schema17-revoke'),revoked);
  const snapshot=db.prepare('SELECT * FROM agent_machine_keys ORDER BY id').all();
  migrate();
  assert.deepEqual(db.prepare('SELECT * FROM agent_machine_keys ORDER BY id').all(),snapshot);
  db.pragma('user_version = 18');
  assert.throws(()=>migrate(),/новее поддерживаемой 17/);
  db.pragma('user_version = 17');
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A1b2b1',from:16,to:17,
    oldOwnerAndReadyPreserved:true,encryptedCredentialsPreserved:true,
    noTokenDuringMigration:true,tokenHashOnly:true,oneTimeReplay:true,
    revocationBlocksImmediately:true,rerunSafe:true,downgradeDenied:true}));
}finally{
  db.close();await fs.rm(dataDir,{recursive:true,force:true});
}
