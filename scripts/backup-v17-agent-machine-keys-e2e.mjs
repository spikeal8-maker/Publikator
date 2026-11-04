import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-backup17-machine-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='schema17-backup-master-key-longer-than-thirty-two-chars';
process.env.PUBLIC_BASE_URL='http://127.0.0.1:8080';

const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {config}=await import('../dist/config.js');
const {DATABASE_SCHEMA_VERSION}=await import('../dist/schema.js');
const {encryptJson,decryptJson}=await import('../dist/crypto.js');
const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');
const {issueOwnerMachineKey,rotateOwnerMachineKey}=await import('../dist/agent-machine-keys.js');
const {createBackupBundle,resolveBackupBundle,stageRestoreBundle}=await import('../dist/backups.js');
const {applyPendingRestore}=await import('../dist/restore-bootstrap.js');

migrate();
assert.ok(DATABASE_SCHEMA_VERSION>=17);
createOrRecoverAdmin('INITIAL',createAdminSetupGrant('INITIAL'),'owner',
  'machine-backup-owner-password-2026','machine-backup-owner-password-2026');
const now=nowIso(),prj=db.prepare('SELECT id FROM projects LIMIT 1').get().id;
const acc=id('acc'),post=id('post'),agent=id('agent');
const credential={botToken:'fixture-provider-credential-not-machine-token',chatId:'@safe'};
db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'telegram','Retained encrypted socials',?,1,?,?)")
  .run(acc,encryptJson(credential),now,now);
db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at) VALUES (?,?,?,'Retain posted state','READY','APPROVED','MANUAL',?,?)")
  .run(post,prj,'Existing READY',now,now);
db.prepare("INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (?,?,?,1,'PENDING',0,?)")
  .run(id('target'),post,acc,now);
db.prepare("INSERT INTO agent_principals(id,owner_admin_id,name,client_kind,created_at,updated_at) VALUES (?,'owner','n8n machine agent','n8n',?,?)")
  .run(agent,now,now);
db.prepare("INSERT INTO agent_grants(agent_id,preset_id,scope_ids_json,project_ids_json,created_at,updated_at) VALUES (?,'CUSTOM',?,?,?,?)")
  .run(agent,JSON.stringify(['projects:read','posts:read']),JSON.stringify([prj]),now,now);
const initial=issueOwnerMachineKey(agent,{
  expectedGrantVersion:1,scopeIds:['projects:read'],ttlHours:24
},'backup17-create-token');
const rotated=rotateOwnerMachineKey(agent,initial.machineKey.keyId,{
  expectedGrantVersion:1,ttlHours:24,confirm:true
},'backup17-rotate-token');
assert.notEqual(initial.bearerToken,rotated.bearerToken);
const tables=[
  ['agents','agent_principals','id'],
  ['grants','agent_grants','agent_id'],
  ['keys','agent_machine_keys','id'],
  ['receipts','agent_owner_operation_receipts','request_id'],
  ['events','agent_activity_events','sequence'],
  ['admin','admin_users','id'],
  ['accounts','social_accounts','id'],
  ['posts','posts','id'],
  ['targets','post_targets','id']
];
const before=Object.fromEntries(tables.map(([key,table,order])=>
  [key,db.prepare('SELECT * FROM '+table+' ORDER BY '+order).all()]));
for(const kind of ['keys','receipts','events']){
  const text=JSON.stringify(before[kind]);
  assert.ok(!text.includes(initial.bearerToken));
  assert.ok(!text.includes(rotated.bearerToken));
  assert.ok(!text.includes(process.env.APP_MASTER_KEY));
  assert.ok(!text.includes('backup17-create-token'));
}
const bundle=await createBackupBundle('machine-keys-schema17-rollback-proof');
const archive=resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(archive)).size>0);
db.prepare('DELETE FROM agent_owner_operation_receipts').run();
db.prepare('DELETE FROM agent_activity_events').run();
db.prepare('DELETE FROM agent_machine_keys').run();
db.prepare("UPDATE agent_principals SET status='REVOKED' WHERE id=?").run(agent);
db.prepare("UPDATE posts SET status='DRAFT' WHERE id=?").run(post);
db.prepare('UPDATE social_accounts SET credentials_encrypted=? WHERE id=?')
  .run(encryptJson({botToken:'changed-credential'}),acc);
const staged=await stageRestoreBundle(archive);
assert.equal(staged.manifest.schemaVersion,DATABASE_SCHEMA_VERSION);
db.close();
const applied=await applyPendingRestore();
assert.equal(applied.applied,true);
const restored=new Database(config.dbPath,{readonly:true,fileMustExist:true});
try{
  assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(Number(restored.pragma('user_version',{simple:true})),DATABASE_SCHEMA_VERSION);
  for(const [key,table,order] of tables){
    assert.deepEqual(restored.prepare('SELECT * FROM '+table+' ORDER BY '+order).all(),before[key],
      'canonical restore must retain '+table);
  }
  const stored=restored.prepare('SELECT * FROM agent_machine_keys WHERE id=?')
    .get(rotated.machineKey.keyId);
  assert.equal(stored.token_hash.length,64);
  assert.equal(stored.revoked_at,null);
  const old=restored.prepare('SELECT * FROM agent_machine_keys WHERE id=?')
    .get(initial.machineKey.keyId);
  assert.ok(old.revoked_at,'rotated source key must remain revoked');
  assert.deepEqual(decryptJson(restored.prepare('SELECT credentials_encrypted FROM social_accounts WHERE id=?')
    .get(acc).credentials_encrypted),credential);
  assert.equal(restored.prepare('SELECT status FROM posts WHERE id=?').get(post).status,'READY');
  assert.deepEqual(restored.pragma('foreign_key_check'),[]);
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A1b2b1',schema:DATABASE_SCHEMA_VERSION,
    machineHashesRestored:true,rotatedRevocationPreserved:true,
    ownerReceiptsAndAuditPreserved:true,encryptedCredentialRestored:true,
    legacyReadyPreserved:true,canonicalBackupRestore:true}));
}finally{
  restored.close();await fs.rm(dataDir,{recursive:true,force:true});
}
