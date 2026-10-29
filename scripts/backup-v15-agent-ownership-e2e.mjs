import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-backup15-agent-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='agent-backup15-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='http://127.0.0.1:8080';

const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {config}=await import('../dist/config.js');
const {DATABASE_SCHEMA_VERSION}=await import('../dist/schema.js');
const {encryptJson,decryptJson}=await import('../dist/crypto.js');
const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');
const {createBackupBundle,resolveBackupBundle,stageRestoreBundle}=await import('../dist/backups.js');
const {applyPendingRestore}=await import('../dist/restore-bootstrap.js');

migrate();
assert.ok(DATABASE_SCHEMA_VERSION >= 15);
const setup=createAdminSetupGrant('INITIAL');
assert.ok(createOrRecoverAdmin('INITIAL',setup,'owner','a1a-backup-owner-password-2026','a1a-backup-owner-password-2026'));
const projectId=db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const timestamp=nowIso(),accountId=id('acc'),postId=id('post'),agentId='agent_backup15';
const sensitive={botToken:'synthetic-telegram-backup-secret',chatId:'@test'};
const encrypted=encryptJson(sensitive);
db.prepare(`INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,'telegram','Existing social target',?,1,?,?)`).run(accountId,encrypted,timestamp,timestamp);
db.prepare(`INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at)
  VALUES (?,?,'Existing READY','Safe scheduled fixture','READY','APPROVED','MANUAL',?,?)`)
  .run(postId,projectId,timestamp,timestamp);
db.prepare(`INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at)
  VALUES (?,?,?,1,'PENDING',0,?)`).run(id('target'),postId,accountId,timestamp);
db.prepare(`INSERT INTO agent_principals(id,owner_admin_id,name,client_kind,created_at,updated_at)
  VALUES (?,'owner','ChatGPT — ASA Lab','chatgpt',?,?)`).run(agentId,timestamp,timestamp);
const policy={
  approvedPolicyVersion:2,projectIds:[projectId],accountIds:[accountId],
  allowedFormats:['TEXT_ONLY','IMAGE'],dailyMax:2,timezone:'Europe/Moscow',
  expiresAt:'2026-11-25T19:00:00Z'
};
const policyJson=JSON.stringify(policy);
const scopeJson=JSON.stringify(['posts:read','posts:write','approval:request','publish:request']);
db.prepare(`INSERT INTO agent_grants(
  agent_id,preset_id,preset_version,grant_version,scope_ids_json,
  project_ids_json,account_ids_json,source_connector_ids_json,publish_mode,
  preapproved_policy_json,created_at,updated_at)
  VALUES (?,'FULL_CONTENT',1,4,?,?,?,'[]','PREAPPROVED_POLICY',?,?,?)`)
  .run(agentId,scopeJson,JSON.stringify([projectId]),JSON.stringify([accountId]),policyJson,timestamp,timestamp);
db.prepare(`INSERT INTO agent_activity_events(
  event_id,agent_id,actor_type,origin,request_id,operation_id,post_id,
  stage,outcome,safe_summary,grant_version,occurred_at)
  VALUES (?,?,'OWNER','UI','req_owner_grant','owner.agent_grant.update',?,
    'POLICY_CHANGED','SUCCEEDED','Владелец изменил разрешения бота',4,?)`)
  .run('evt_a1a_backup_policy',agentId,postId,timestamp);
const before={
  principals:db.prepare('SELECT * FROM agent_principals ORDER BY id').all(),
  grants:db.prepare('SELECT * FROM agent_grants ORDER BY agent_id').all(),
  events:db.prepare('SELECT * FROM agent_activity_events ORDER BY sequence').all(),
  admin:db.prepare('SELECT * FROM admin_users').all(),
  accounts:db.prepare('SELECT * FROM social_accounts').all(),
  posts:db.prepare('SELECT * FROM posts').all(),
  targets:db.prepare('SELECT * FROM post_targets').all()
};
assert.ok(before.grants[0].preapproved_policy_json);
assert.equal(JSON.parse(before.grants[0].preapproved_policy_json).dailyMax,2);
for(const name of ['principals','grants','events']) {
  assert.ok(!JSON.stringify(before[name]).includes(sensitive.botToken),'no plaintext provider token in '+name);
}
const backup=await createBackupBundle('agent-schema15-ownership-proof');
const file=resolveBackupBundle(backup.name);
assert.ok((await fs.stat(file)).size>0);
db.prepare("UPDATE agent_principals SET status='REVOKED' WHERE id=?").run(agentId);
db.prepare("UPDATE agent_grants SET publish_mode='DRAFT_ONLY', preapproved_policy_json=NULL,scope_ids_json='[]' WHERE agent_id=?").run(agentId);
db.prepare('DELETE FROM agent_activity_events').run();
db.prepare("UPDATE posts SET status='DRAFT' WHERE id=?").run(postId);
db.prepare('UPDATE social_accounts SET credentials_encrypted=? WHERE id=?')
  .run(encryptJson({botToken:'mutated-secret'}),accountId);
const staged=await stageRestoreBundle(file);
assert.equal(staged.manifest.schemaVersion,DATABASE_SCHEMA_VERSION);
db.close();
const applied=await applyPendingRestore();
assert.equal(applied.applied,true);
const restored=new Database(config.dbPath,{fileMustExist:true});
try {
  assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(Number(restored.pragma('user_version',{simple:true})),DATABASE_SCHEMA_VERSION);
  for(const [field,table,order]of [
    ['principals','agent_principals','id'],['grants','agent_grants','agent_id'],
    ['events','agent_activity_events','sequence'],['admin','admin_users','id'],
    ['accounts','social_accounts','id'],['posts','posts','id'],['targets','post_targets','id']
  ]) {
    assert.deepEqual(restored.prepare('SELECT * FROM '+table+' ORDER BY '+order).all(),
      [...before[field]].sort((a,b)=>String(a[order]).localeCompare(String(b[order]))),
      'canonical backup/restore must preserve '+field);
  }
  assert.deepEqual(decryptJson(restored.prepare('SELECT credentials_encrypted FROM social_accounts WHERE id=?')
    .get(accountId).credentials_encrypted),sensitive);
  assert.equal(restored.prepare('SELECT publish_mode FROM agent_grants WHERE agent_id=?')
    .get(agentId).publish_mode,'PREAPPROVED_POLICY');
  assert.equal(restored.prepare('SELECT status FROM posts WHERE id=?').get(postId).status,'READY');
  assert.deepEqual(restored.pragma('foreign_key_check'),[]);
  const ddl=restored.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_activity_events'"
  ).get().sql;
  assert.match(ddl,/length\(CAST\(target_account_ids_json AS BLOB\)\)/);
  assert.match(ddl,/length\(CAST\(safe_summary AS BLOB\)\)/);
  assert.match(ddl,/instr\(safe_summary, char\(0\)\)/);
  const triggers=restored.prepare([
    "SELECT name FROM sqlite_master WHERE type='trigger'",
    "AND name IN ('trg_agent_audit_payload_insert','trg_agent_audit_payload_update')",
    "ORDER BY name"
  ].join(' ')).all().map(row=>row.name);
  assert.deepEqual(triggers,[
    'trg_agent_audit_payload_insert','trg_agent_audit_payload_update'
  ],'canonical backup must preserve both SQL audit guards');
  const beforeAudit=restored.prepare('SELECT * FROM agent_activity_events ORDER BY sequence').all();
  const invalidInsert=restored.prepare([
    'INSERT INTO agent_activity_events',
    '(event_id,agent_id,actor_type,origin,request_id,operation_id,stage,outcome,',
    'target_account_ids_json,safe_summary,occurred_at)',
    "VALUES (? ,?,'OWNER','UI','req_restore','agent.backup.restore',",
    "'COMPLETED','SUCCEEDED',?,?,?)"
  ].join(' '));
  const invalidUpdate=restored.prepare([
    'UPDATE agent_activity_events SET target_account_ids_json=?,safe_summary=?',
    'WHERE event_id=?'
  ].join(' '));
  // Bypass CHECK to prove triggers independently defend both INSERT and
  // UPDATE, including on a restored file and not only on a fresh migration.
  restored.pragma('ignore_check_constraints = ON');
  try {
    assert.throws(()=>invalidInsert.run('evt_bad_json_restore',agentId,
      '[false]','Нормальное событие',timestamp),/AGENT_AUDIT_INVALID_TARGET_IDS/);
    assert.throws(()=>invalidInsert.run('evt_bad_summary_restore',agentId,
      '[]','ok'+String.fromCharCode(0)+'x'.repeat(300000),timestamp),
      /AGENT_AUDIT_INVALID_SUMMARY/);
    assert.throws(()=>invalidUpdate.run('[42]','safe','evt_a1a_backup_policy'),
      /AGENT_AUDIT_INVALID_TARGET_IDS/);
    assert.throws(()=>invalidUpdate.run('[]','begin'+String.fromCharCode(0)+'tail',
      'evt_a1a_backup_policy'),/AGENT_AUDIT_INVALID_SUMMARY/);
  } finally {
    restored.pragma('ignore_check_constraints = OFF');
  }

  // The canonical restored database must enforce UTF-8 *inside SQLite*.
  // Reject both storage-class bypasses and malformed TEXT on INSERT/UPDATE,
  // even when the caller has switched ordinary CHECK constraints off.
  const restoredRows = () => restored.prepare(
    'SELECT * FROM agent_activity_events ORDER BY sequence').all();
  const restoredBefore = restoredRows();
  const originalReady = restored.prepare('SELECT * FROM posts WHERE id=?').get(postId);
  const originalCredential = restored.prepare(
    'SELECT credentials_encrypted FROM social_accounts WHERE id=?').get(accountId);
  let restoredProbeNo = 0;
  function rejectRestoredSql(field, expression, label) {
    const targetExpr = field === 'target_account_ids_json' ? expression : "'[]'";
    const summaryExpr = field === 'safe_summary' ? expression : "'safe'";
    const insertSql = [
      'INSERT INTO agent_activity_events',
      '(event_id,agent_id,actor_type,origin,request_id,operation_id,',
      'stage,outcome,target_account_ids_json,safe_summary,occurred_at)',
      "VALUES ('evt_restore_bad_" + (++restoredProbeNo) + "','" + agentId +
      "','OWNER','UI','restore_probe','audit.restore',",
      "'COMPLETED','SUCCEEDED'," + targetExpr + ',' + summaryExpr + ",'" +
      timestamp + "')"
    ].join(' ');
    const updateSql = 'UPDATE agent_activity_events SET ' + field + '=' +
      expression + " WHERE event_id='evt_a1a_backup_policy'";
    const error = field === 'safe_summary'
      ? /AGENT_AUDIT_INVALID_SUMMARY/
      : /AGENT_AUDIT_INVALID_TARGET_IDS/;
    for (const [op, sql] of [['INSERT', insertSql], ['UPDATE', updateSql]]) {
      assert.throws(() => restored.exec(sql), error, label + ' ' + op);
      assert.deepEqual(restoredRows(), restoredBefore,
        'corrupt restored audit mutation must roll back: ' + label + ' ' + op);
      assert.deepEqual(restored.prepare('SELECT * FROM posts WHERE id=?').get(postId),
        originalReady);
      assert.deepEqual(restored.prepare(
        'SELECT credentials_encrypted FROM social_accounts WHERE id=?').get(accountId),
        originalCredential);
    }
  }
  for (const ignoreCheck of [false,true]) {
    restored.pragma('ignore_check_constraints = ' + (ignoreCheck ? 'ON' : 'OFF'));
    try {
      rejectRestoredSql('safe_summary', "X'6F6B'", 'valid UTF-8 BLOB');
      rejectRestoredSql('safe_summary', "CAST(X'FF' AS TEXT)", 'invalid UTF-8 TEXT');
      rejectRestoredSql('safe_summary', "CAST(X'EDA080' AS TEXT)", 'surrogate TEXT');
      rejectRestoredSql('target_account_ids_json', "X'5B5D'", 'JSON [] BLOB');
      rejectRestoredSql('target_account_ids_json', "CAST(X'5B22FF225D' AS TEXT)",
        'corrupt UTF-8 TEXT JSON');
      rejectRestoredSql('safe_summary', "'ok'||char(0)||CAST(zeroblob(300000) AS TEXT)",
        'NUL plus 300KB tail');
    } finally {
      restored.pragma('ignore_check_constraints = OFF');
    }
  }
  const savedTriggerSql = restored.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_agent_audit_payload_insert'"
  ).get().sql;
  assert.match(savedTriggerSql,/WITH RECURSIVE utf8_reconstruction/,
    'canonical restore must retain the strict UTF-8 guard');
  // Valid Unicode still works after restore. The SAVEPOINT keeps the backup's
  // historical snapshot byte-identical after exercising positive writes.
  restored.exec('SAVEPOINT restored_utf8_positive');
  try {
    restored.prepare(
      "INSERT INTO agent_activity_events(event_id,actor_type,origin,request_id," +
      "operation_id,stage,target_account_ids_json,safe_summary,occurred_at) " +
      "VALUES ('evt_restore_valid_unicode','SYSTEM','SYSTEM','restore_positive'," +
      "'audit.unicode','COMPLETED',?,?,?)"
    ).run('[]', 'Русский текст 😀 \uFFFD', timestamp);
    assert.equal(restored.prepare(
      "SELECT safe_summary FROM agent_activity_events WHERE event_id='evt_restore_valid_unicode'"
    ).get().safe_summary, 'Русский текст 😀 \uFFFD');
  } finally {
    restored.exec('ROLLBACK TO restored_utf8_positive; RELEASE restored_utf8_positive');
  }

  assert.deepEqual(restored.prepare('SELECT * FROM agent_activity_events ORDER BY sequence').all(),
    beforeAudit,'invalid changes after restore must leave audit untouched');
  assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');
  assert.deepEqual(restored.pragma('foreign_key_check'),[]);
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A1a',schema:15,
    grantAndPolicyRestored:true,agentAuditRestored:true,ownerPreserved:true,
    readyPostPreserved:true,encryptedCredentialsRestored:true,canonicalBackupRestore:true,
    auditTriggersRestored:true,restoredDirectSqlGuards:true,restoredStrictUtf8:true}));
} finally {
  restored.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
