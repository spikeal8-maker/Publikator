import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-agent-backup15-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='synthetic-v15-backup-master-key-longer-than-thirty-two';
process.env.PUBLIC_BASE_URL='http://127.0.0.1:8080';
const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {config}=await import('../dist/config.js');
const {encryptJson,decryptJson}=await import('../dist/crypto.js');
const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');
const {createBackupBundle,resolveBackupBundle,stageRestoreBundle}=await import('../dist/backups.js');
const {applyPendingRestore}=await import('../dist/restore-bootstrap.js');
migrate();
const grant=createAdminSetupGrant('INITIAL');
createOrRecoverAdmin('INITIAL',grant,'owner_admin','owner-password-long-2026','owner-password-long-2026');
const stamp=nowIso(),project=db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const account=id('acc'),post=id('post'),agent=id('agent');
const credential={accessToken:'synthetic-test-only-credential',groupId:'12345',authKind:'COMMUNITY'};
db.prepare(`INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES(?,?,?, ?,1,?,?)`).run(account,'vk','Existing Synthetic',encryptJson(credential),stamp,stamp);
db.prepare(`INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at)
  VALUES(?,?,?,?,'READY','APPROVED','MANUAL',?,?)`).run(post,project,'Existing READY','Legacy publication untouched',stamp,stamp);
db.prepare(`INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at)
  VALUES(?,?,?,1,'PENDING',0,?)`).run(id('target'),post,account,stamp);
db.prepare(`INSERT INTO agent_principals(id,owner_admin_id,display_name,client_kind,created_at,updated_at)
  VALUES(?,'owner',?,'chatgpt',?,?)`).run(agent,'ChatGPT Synthetic',stamp,stamp);
db.prepare(`INSERT INTO agent_grants(agent_id,preset_id,preset_version,publish_mode,grant_version,
  scope_ids_json,project_ids_json,account_ids_json,source_connector_ids_json,created_at,updated_at)
  VALUES(?, 'LIMITED',1,'DRAFT_ONLY',2,?,?,?,?,?,?)`).run(
    agent,JSON.stringify(['projects:read','posts:read','posts:write']),
    JSON.stringify([project]),JSON.stringify([account]),'[]',stamp,stamp);

const select=()=>({
  owner:db.prepare('SELECT * FROM admin_users').get(),
  principals:db.prepare('SELECT * FROM agent_principals ORDER BY id').all(),
  grants:db.prepare('SELECT * FROM agent_grants ORDER BY agent_id').all(),
  posts:db.prepare('SELECT * FROM posts ORDER BY id').all(),
  targets:db.prepare('SELECT * FROM post_targets ORDER BY id').all(),
  accounts:db.prepare('SELECT * FROM social_accounts ORDER BY id').all()
});
const before=select();
const bundle=await createBackupBundle('synthetic-agent-schema15');
await fs.stat(resolveBackupBundle(bundle.name));
// Loss simulation: agent deleted and legacy content modified after backup.
db.prepare('DELETE FROM agent_principals WHERE id=?').run(agent);
db.prepare("UPDATE posts SET status='DRAFT' WHERE id=?").run(post);
db.prepare('DELETE FROM social_accounts WHERE id=?').run(account);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_grants').get().n,0,'delete cascade works');
const stage=await stageRestoreBundle(resolveBackupBundle(bundle.name));
assert.equal(stage.manifest.schemaVersion,15);
db.close();
const result=await applyPendingRestore();
assert.equal(result.applied,true);
const restored=new Database(config.dbPath,{readonly:true,fileMustExist:true});
try{
  assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(Number(restored.pragma('user_version',{simple:true})),15);
  for(const [key,table]of [['principals','agent_principals'],['grants','agent_grants'],
    ['posts','posts'],['targets','post_targets'],['accounts','social_accounts']]) {
    const order=table==='agent_grants'?'agent_id':'id';
    assert.deepEqual(restored.prepare('SELECT * FROM '+table+' ORDER BY '+order).all(),before[key],key+' restore');
  }
  assert.deepEqual(restored.prepare('SELECT * FROM admin_users').get(),before.owner);
  assert.equal(restored.prepare('SELECT preset_id,publish_mode FROM agent_grants WHERE agent_id=?').get(agent).publish_mode,'DRAFT_ONLY');
  assert.deepEqual(decryptJson(restored.prepare('SELECT credentials_encrypted FROM social_accounts WHERE id=?').get(account).credentials_encrypted),credential);
  assert.equal(restored.pragma('foreign_key_check').length,0);
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A1a',schema:15,
    principalsAndGrantPreserved:true,ownerSessionSchemaPreserved:true,readyPostPreserved:true,
    encryptedCredentialDecryptable:true,canonicalBackupRestore:true}));
} finally {
  restored.close();
  await fs.rm(dir,{recursive:true,force:true});
}
