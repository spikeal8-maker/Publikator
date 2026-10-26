import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-backup18-agent-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='schema18-canonical-backup-master-key-long-enough-2026';
process.env.PUBLIC_BASE_URL='http://127.0.0.1:8080';

const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {config}=await import('../dist/config.js');
const {DATABASE_SCHEMA_VERSION}=await import('../dist/schema.js');
const {encryptJson,decryptJson}=await import('../dist/crypto.js');
const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');
const {createBackupBundle,resolveBackupBundle,stageRestoreBundle}=await import('../dist/backups.js');
const {applyPendingRestore}=await import('../dist/restore-bootstrap.js');

migrate();
assert.equal(DATABASE_SCHEMA_VERSION,18);
createOrRecoverAdmin('INITIAL',createAdminSetupGrant('INITIAL'),'owner',
  'schema18-backup-owner-password-2026','schema18-backup-owner-password-2026');
const now=nowIso(),prj=db.prepare('SELECT id FROM projects LIMIT 1').get().id;
const agent=id('agent'),draft=id('post'),legacy=id('post'),account=id('acc');
const sensitive={botToken:'private-existing-telegram-credential-2026',chatId:'@legacy'};
db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'telegram','Existing social account',?,1,?,?)")
  .run(account,encryptJson(sensitive),now,now);
db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'Legacy READY','manual fixture','READY','APPROVED','MANUAL','manual',?,?)")
  .run(legacy,prj,now,now);
db.prepare("INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (?,?,?,1,'PENDING',0,?)")
  .run(id('target'),legacy,account,now);
db.prepare("INSERT INTO agent_principals(id,owner_admin_id,name,client_kind,created_at,updated_at) VALUES (?,'owner','Synthetic draft agent','n8n',?,?)")
  .run(agent,now,now);
db.prepare('INSERT INTO agent_grants(agent_id,created_at,updated_at) VALUES (?,?,?)')
  .run(agent,now,now);
db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'Agent-only DRAFT','safe draft body','DRAFT','DRAFT','MANUAL','agent-api',?,?)")
  .run(draft,prj,now,now);
db.prepare('INSERT INTO agent_draft_ownership(post_id,agent_id,creation_grant_version,creation_operation_id,created_at) VALUES (?,?,?,?,?)')
  .run(draft,agent,1,'createAgentPost',now);
db.prepare('INSERT INTO agent_operation_receipts(receipt_id,agent_id,operation_name,idempotency_key_hash,canonical_payload_hash,post_id,phase,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  .run(id('arec'),agent,'createAgentPost','b'.repeat(64),'c'.repeat(64),
    draft,'COMPLETED',JSON.stringify({postId:draft,contentVersion:1,status:'DRAFT'}),now,now);
db.prepare("INSERT INTO agent_activity_events(event_id,agent_id,actor_type,origin,request_id,operation_id,post_id,stage,outcome,safe_summary,grant_version,occurred_at) VALUES (?,?,'AGENT','REST','req_safe','createAgentPost',?,'COMPLETED','SUCCEEDED','Agent-created safe draft',1,?)")
  .run(id('evt'),agent,draft,now);
const tables=[
  ['admin','admin_users','id'],
  ['accounts','social_accounts','id'],
  ['posts','posts','id'],
  ['targets','post_targets','id'],
  ['agents','agent_principals','id'],
  ['grants','agent_grants','agent_id'],
  ['events','agent_activity_events','sequence'],
  ['owner','agent_draft_ownership','post_id'],
  ['receipts','agent_operation_receipts','receipt_id']
];
const before=Object.fromEntries(tables.map(([key,table,sort])=>
  [key,db.prepare('SELECT * FROM '+table+' ORDER BY '+sort).all()]));
for(const key of ['agents','grants','events','owner','receipts']){
  assert.ok(!JSON.stringify(before[key]).includes(sensitive.botToken));
}

const result=await createBackupBundle('agent-schema18-draft-provenance');
const archive=resolveBackupBundle(result.name);
assert.ok((await fs.stat(archive)).size>0);
db.prepare('DELETE FROM agent_operation_receipts').run();
db.prepare('DELETE FROM agent_activity_events').run();
db.prepare("UPDATE posts SET body='mutated after backup' WHERE id=?").run(draft);
db.prepare("UPDATE posts SET status='DRAFT' WHERE id=?").run(legacy);
db.prepare("UPDATE agent_principals SET status='PAUSED' WHERE id=?").run(agent);
db.prepare("UPDATE social_accounts SET credentials_encrypted=? WHERE id=?")
  .run(encryptJson({botToken:'changed-local-credential'}),account);

const staged=await stageRestoreBundle(archive);
assert.equal(staged.manifest.schemaVersion,18);
db.close();
const applied=await applyPendingRestore();
assert.equal(applied.applied,true);
const restored=new Database(config.dbPath,{readonly:false,fileMustExist:true});
try{
  assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(Number(restored.pragma('user_version',{simple:true})),18);
  for(const [key,table,sort]of tables){
    assert.deepEqual(restored.prepare('SELECT * FROM '+table+' ORDER BY '+sort).all(),
      before[key],'canonical backup must preserve '+table);
  }
  const encoded=restored.prepare('SELECT credentials_encrypted FROM social_accounts WHERE id=?')
    .get(account).credentials_encrypted;
  assert.deepEqual(decryptJson(encoded),sensitive);
  assert.equal(restored.prepare('SELECT status FROM posts WHERE id=?').get(legacy).status,'READY');
  assert.equal(restored.prepare('SELECT status FROM posts WHERE id=?').get(draft).status,'DRAFT');
  assert.throws(()=>restored.prepare("UPDATE posts SET status='READY' WHERE id=?").run(draft),
    /AGENT_OWNER_CONSENT_REQUIRED/,'restored safety trigger must remain active');
  assert.throws(()=>restored.prepare('DELETE FROM agent_draft_ownership WHERE post_id=?').run(draft),
    /AGENT_OWNER_IMMUTABLE/);
  assert.throws(()=>restored.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'invalid agent','bad','READY','APPROVED','MANUAL','agent-api',?,?)")
    .run(id('post'),prj,now,now),/AGENT_OWNER_CONSENT_REQUIRED/,
    'no unowned agent-api READY post may be inserted after restore');
  assert.throws(()=>restored.prepare('INSERT INTO agent_operation_receipts(receipt_id,agent_id,operation_name,idempotency_key_hash,canonical_payload_hash,post_id,phase,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id('arec'),agent,'createAgentPost','d'.repeat(64),'e'.repeat(64),
      legacy,'COMPLETED',JSON.stringify({postId:legacy}),now,now),
    /AGENT_RECEIPT_FOREIGN_POST/,'receipts cannot borrow a manual owner post');
  assert.deepEqual(restored.pragma('foreign_key_check'),[]);
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A2b0',schema:18,
    immutableOriginRestored:true,durableReceiptsRestored:true,
    blockedPublisherStateAfterRestore:true,manualReadyPreserved:true,
    ownerAndAuditPreserved:true,encryptedCredentialsRestored:true,
    canonicalBackupRestore:true}));
}finally{
  restored.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
