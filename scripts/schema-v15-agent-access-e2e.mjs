import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-agent-v15-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='synthetic-v15-agent-schema-master-longer-than-thirty-two';
process.env.PUBLIC_BASE_URL='http://127.0.0.1:8080';
const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {DATABASE_SCHEMA_VERSION}=await import('../dist/schema.js');
const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');
const {encryptJson,decryptJson}=await import('../dist/crypto.js');
migrate();
try {
  assert.equal(DATABASE_SCHEMA_VERSION,15);
  assert.equal(Number(db.pragma('user_version',{simple:true})),15);
  for(const table of ['agent_principals','agent_grants']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,'no auto-created agent');
  }
  const setup=createAdminSetupGrant('INITIAL');
  createOrRecoverAdmin('INITIAL',setup,'owner_admin','owner-long-password-2026','owner-long-password-2026');
  const stamp=nowIso(),project=db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
  const account=id('acc'),post=id('post'),secret=encryptJson({botToken:'synthetic-token',chatId:'@synthetic'});
  db.prepare(`INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES(?,?,?, ?,1,?,?)`).run(account,'telegram','Existing Synthetic',secret,stamp,stamp);
  db.prepare(`INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at)
    VALUES(?,?,?,?,'READY','APPROVED','MANUAL',?,?)`).run(post,project,'Existing READY','Human publication preserved',stamp,stamp);
  db.prepare(`INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at)
    VALUES(?,?,?,1,'PENDING',0,?)`).run(id('target'),post,account,stamp);
  const query=[
    ['projects','SELECT * FROM projects ORDER BY id'],
    ['accounts','SELECT * FROM social_accounts ORDER BY id'],
    ['posts','SELECT * FROM posts ORDER BY id'],
    ['targets','SELECT * FROM post_targets ORDER BY id'],
    ['owners','SELECT * FROM admin_users ORDER BY id']
  ];
  const before=Object.fromEntries(query.map(([name,sql])=>[name,db.prepare(sql).all()]));
  // Emulate an installed schema-14 DB with real owner, READY post and encrypted credential.
  db.exec('DROP TABLE agent_grants; DROP TABLE agent_principals;');
  db.pragma('user_version = 14');
  migrate();
  assert.equal(Number(db.pragma('user_version',{simple:true})),15);
  for(const [name,sql]of query)assert.deepEqual(db.prepare(sql).all(),before[name],name+' preserved');
  assert.deepEqual(decryptJson(secret),{botToken:'synthetic-token',chatId:'@synthetic'});

  const agent=id('agent');
  db.prepare(`INSERT INTO agent_principals(id,owner_admin_id,display_name,client_kind,created_at,updated_at)
    VALUES(?,'owner',?,'chatgpt',?,?)`).run(agent,'ChatGPT Synthetic',stamp,stamp);
  db.prepare('INSERT INTO agent_grants(agent_id,created_at,updated_at) VALUES(?,?,?)').run(agent,stamp,stamp);
  const p=db.prepare('SELECT * FROM agent_principals WHERE id=?').get(agent);
  const g=db.prepare('SELECT * FROM agent_grants WHERE agent_id=?').get(agent);
  assert.equal(p.status,'ACTIVE');assert.equal(p.token_version,1);
  assert.equal(g.preset_id,'OBSERVER');assert.equal(g.preset_version,1);
  assert.equal(g.publish_mode,'DRAFT_ONLY');assert.equal(g.grant_version,1);
  for(const column of ['scope_ids_json','project_ids_json','account_ids_json','source_connector_ids_json'])
    assert.deepEqual(JSON.parse(g[column]),[],'deny by default '+column);
  assert.equal(g.preapproved_policy_json,null);
  assert.throws(()=>db.prepare("UPDATE agent_grants SET preset_id='ADMIN' WHERE agent_id=?").run(agent),/CHECK/);
  assert.throws(()=>db.prepare("UPDATE agent_grants SET scope_ids_json='{ }' WHERE agent_id=?").run(agent),/CHECK/);
  assert.throws(()=>db.prepare("UPDATE agent_grants SET account_ids_json='[broken' WHERE agent_id=?").run(agent),/CHECK|malformed/);
  assert.throws(()=>db.prepare("UPDATE agent_grants SET publish_mode='PREAPPROVED_POLICY' WHERE agent_id=?").run(agent),/CHECK/);
  assert.throws(()=>db.prepare("INSERT INTO agent_grants(agent_id,created_at,updated_at) VALUES('agent_missing',?,?)").run(stamp,stamp),/FOREIGN KEY/);

  // Named FULL rights never enable auto-posting.
  db.prepare("UPDATE agent_grants SET preset_id='FULL_CONTENT',grant_version=grant_version+1 WHERE agent_id=?").run(agent);
  assert.equal(db.prepare('SELECT publish_mode FROM agent_grants WHERE agent_id=?').get(agent).publish_mode,'DRAFT_ONLY');
  const policy=JSON.stringify({projectIds:[project],accountIds:[account],allowedFormats:['TEXT_ONLY'],
    dailyMax:2,timezone:'Europe/Moscow',expiresAt:'2026-11-30T23:00:00Z',approvedPolicyVersion:1});
  db.prepare(`UPDATE agent_grants SET publish_mode='PREAPPROVED_POLICY',preapproved_policy_json=?,
    grant_version=grant_version+1 WHERE agent_id=?`).run(policy,agent);
  assert.deepEqual(JSON.parse(db.prepare('SELECT preapproved_policy_json FROM agent_grants WHERE agent_id=?').get(agent).preapproved_policy_json),JSON.parse(policy));
  db.prepare("UPDATE agent_grants SET publish_mode='DRAFT_ONLY',preapproved_policy_json=NULL,grant_version=grant_version+1 WHERE agent_id=?").run(agent);
  const saved=db.prepare('SELECT * FROM agent_grants WHERE agent_id=?').get(agent);
  assert.equal(saved.grant_version,4);
  migrate();
  assert.deepEqual(db.prepare('SELECT * FROM agent_grants WHERE agent_id=?').get(agent),saved);
  db.pragma('user_version = 16');
  assert.throws(()=>migrate(),/новее поддерживаемой 15/);
  db.pragma('user_version = 15');
  assert.equal(db.pragma('foreign_key_check').length,0);
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A1a',schema:15,from:14,
    preservedLegacy:true,denyByDefault:true,invalidGrantsRejected:true,repeatSafe:true,downgradeGuard:true}));
} finally {
  db.close();
  await fs.rm(dir,{recursive:true,force:true});
}
