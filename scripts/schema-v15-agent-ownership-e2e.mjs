import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

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
const { ensureAgentAuditGuards } = await import('../dist/agent-ownership-migration.js');

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
  db.exec('DROP TABLE agent_owner_operation_receipts; DROP TABLE agent_activity_events; DROP TABLE agent_grants; DROP TABLE agent_principals;');
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
    '{"approvedPolicyVersion":1.5}',
    '{'
  ]) {
    assert.throws(() => attemptAuto.run('PREAPPROVED_POLICY',invalid,agentId),
      /CHECK constraint|malformed JSON/, 'auto grants require a positive integer owner policy version: '+invalid);
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
    'agent.grant.read','COMPLETED','SUCCEEDED','x'.repeat(241),now),
    /AGENT_AUDIT_INVALID_SUMMARY|CHECK constraint/);
  assert.throws(() => db.prepare(`INSERT INTO agent_activity_events(
    event_id,agent_id,actor_type,origin,request_id,operation_id,stage,safe_summary,occurred_at)
    VALUES (?,?,'AGENT','REST','req_003','media.import','PROGRESS','No job',?)`)
    .run('evt_bad_progress',agentId,now),/CHECK constraint/);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);

  // Direct SQL tests: INSERT and UPDATE must reject invalid JSON/summary
  // even if SQLite CHECK enforcement is disabled. Canonical IDs are the
  // 1..128 ASCII [A-Za-z0-9._:-] used by Agent API; max recipients is 20.
  const auditInsert=db.prepare([
    'INSERT INTO agent_activity_events',
    '(event_id,agent_id,actor_type,origin,request_id,operation_id,',
    'stage,outcome,target_account_ids_json,safe_summary,occurred_at)',
    "VALUES (?,?,?,'REST','req_audit_constraints','agent.audit.validate',",
    "'COMPLETED','SUCCEEDED',?,?,?)"
  ].join(' '));
  const auditUpdate=db.prepare([
    'UPDATE agent_activity_events',
    'SET target_account_ids_json=?,safe_summary=? WHERE event_id=?'
  ].join(' '));
  const auditCount=()=>db.prepare(
    'SELECT COUNT(*) AS n FROM agent_activity_events'
  ).get().n;
  function auditWrite(targets,summary,actor='AGENT') {
    return auditInsert.run(id('evt'),actor==='SYSTEM'?null:agentId,actor,
      targets,summary,now);
  }
  function rejectedAudit(fn,label) {
    const beforeCount=auditCount();
    assert.throws(fn,/AGENT_AUDIT_INVALID_TARGET_IDS|AGENT_AUDIT_INVALID_SUMMARY|CHECK constraint|malformed JSON/,
      label);
    assert.equal(auditCount(),beforeCount,'rejected audit operation must not create rows: '+label);
  }
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('trg_agent_audit_payload_insert','trg_agent_audit_payload_update')"
  ).get().n,2);
  const allowedIds=JSON.stringify(Array.from({length:20},(_,i)=>'acc_'+i+':ok-.'));
  auditWrite('[]','Нормальное событие','OWNER');
  auditWrite(allowedIds,'Пример безопасной записи','AGENT');
  auditWrite('[]','😀'.repeat(240),'SYSTEM');
  auditWrite('[]','Т'.repeat(240),'OWNER');
  assert.equal(db.prepare('SELECT length(CAST(safe_summary AS BLOB)) AS n FROM agent_activity_events WHERE safe_summary=?')
    .get('😀'.repeat(240)).n,960,'240 four-byte Unicode codepoints must be accepted');
  const badJson=[
    ['invalid JSON','{'],['JSON null','null'],['JSON number','3'],['JSON object','{}'],
    ['null element','["acc1",null]'],['boolean element','[false]'],
    ['number element','[42]'],['object element','[{"id":"acc1"}]'],
    ['empty id','[""]'],['overlong id',JSON.stringify(['a'.repeat(129)])],
    ['21 ids',JSON.stringify(Array.from({length:21},(_,i)=>'account_'+i))],
    ['oversized JSON',JSON.stringify(['x'.repeat(300000)])],
    ['invalid whitespace id','["account / escaped"]'],
    ['invalid Unicode id',JSON.stringify(['не-ascii'])],
    ['embedded NUL id',JSON.stringify(['a'+String.fromCharCode(0)+'b'])]
  ];
  for(const [name,bad] of badJson) {
    rejectedAudit(()=>auditWrite(bad,'Нормальный аудит'),'INSERT '+name);
  }
  const badSummaries=[
    ['empty',''],['241 characters','x'.repeat(241)],
    ['NUL first',String.fromCharCode(0)+'ok'],
    ['NUL middle','ok'+String.fromCharCode(0)+'after'],
    ['NUL last','ok'+String.fromCharCode(0)],
    ['NUL with 300KB tail','ok'+String.fromCharCode(0)+'x'.repeat(300000)],
    ['300KB text','x'.repeat(300000)]
  ];
  for(const [name,bad] of badSummaries) {
    rejectedAudit(()=>auditWrite('[]',bad),'INSERT '+name);
  }
  const originalEvent=()=>db.prepare(
    "SELECT * FROM agent_activity_events WHERE event_id='evt_a1a_001'"
  ).get();
  const originalAuditEvent=originalEvent();
  rejectedAudit(()=>auditUpdate.run('[true]','Изменённый аудит','evt_a1a_001'),
    'UPDATE invalid element');
  rejectedAudit(()=>auditUpdate.run('[]','x'+String.fromCharCode(0)+'y','evt_a1a_001'),
    'UPDATE NUL summary');
  rejectedAudit(()=>auditUpdate.run(JSON.stringify(['x'.repeat(300000)]),'OK','evt_a1a_001'),
    'UPDATE oversized JSON');
  assert.deepEqual(originalEvent(),originalAuditEvent,'invalid UPDATE must be atomic');
  auditUpdate.run('["acc_valid"]','Обновление допустимо','evt_a1a_001');
  auditUpdate.run('[]','Разрешения просмотрены','evt_a1a_001');
  assert.deepEqual(originalEvent(),originalAuditEvent,'valid UPDATE then restore remains identical');

  db.pragma('ignore_check_constraints = ON');
  try {
    rejectedAudit(()=>auditWrite('[null]','safe'),'triggers reject JSON without CHECK');
    rejectedAudit(()=>auditWrite('[]','a'+String.fromCharCode(0)+'b'),
      'triggers reject NUL without CHECK');
  } finally {
    db.pragma('ignore_check_constraints = OFF');
  }


  // Raw SQL (not bound JavaScript strings) must not smuggle BLOBs or corrupt
  // TEXT through either audit trigger, with or without CHECK constraints.
  // Compare entire rows and dependent data after *each* rejected statement.
  let directCase = 0;
  const auditRows = () => db.prepare(
    'SELECT * FROM agent_activity_events ORDER BY sequence').all();
  const retainedPosts = db.prepare('SELECT * FROM posts ORDER BY id').all();
  const retainedGrants = db.prepare('SELECT * FROM agent_grants ORDER BY agent_id').all();
  function rejectRawAudit(field, expression, label) {
    const beforeRows = auditRows(), beforeCount = auditCount();
    const error = field === 'safe_summary'
      ? /AGENT_AUDIT_INVALID_SUMMARY/
      : /AGENT_AUDIT_INVALID_TARGET_IDS/;
    const eventId = 'evt_invalid_raw_' + (++directCase);
    const targetSql = field === 'target_account_ids_json' ? expression : "'[]'";
    const summarySql = field === 'safe_summary' ? expression : "'safe'";
    const insertion = [
      'INSERT INTO agent_activity_events',
      '(event_id,agent_id,actor_type,origin,request_id,operation_id,',
      'stage,outcome,target_account_ids_json,safe_summary,occurred_at)',
      "VALUES ('" + eventId + "','" + agentId + "','AGENT','REST',",
      "'raw_sql','audit.probe','COMPLETED','SUCCEEDED',",
      targetSql + ',' + summarySql + ",'" + now + "')"
    ].join(' ');
    const update = 'UPDATE agent_activity_events SET ' + field + '=' +
      expression + " WHERE event_id='evt_a1a_001'";
    for (const [operation, sql] of [['INSERT', insertion], ['UPDATE', update]]) {
      assert.throws(() => db.exec(sql), error, label + ' ' + operation);
      assert.deepEqual(auditRows(), beforeRows, label + ' ' + operation +
        ' must not modify event rows, sequence or historical events');
      assert.equal(auditCount(), beforeCount);
      assert.deepEqual(db.prepare('SELECT * FROM posts ORDER BY id').all(), retainedPosts,
        'rejected direct SQL cannot mutate existing posts');
      assert.deepEqual(db.prepare('SELECT * FROM agent_grants ORDER BY agent_id').all(),
        retainedGrants, 'rejected direct SQL cannot change grant revisions');
    }
  }
  function rawSqlNegativeMatrix() {
    const invalidUtf8 = [
      ['invalid leading FF', 'FF'],
      ['isolated continuation', '80'],
      ['truncated three-byte sequence', 'E282'],
      ['overlong UTF-8', 'C0AF'],
      ['surrogate code point', 'EDA080'],
      ['code point above U+10FFFF', 'F4908080']
    ];
    for (const [label, hex] of invalidUtf8) {
      const jsonHex = '5B22' + hex + '225D'; // ["<raw bytes>"]
      rejectRawAudit('safe_summary', "X'" + hex + "'", label + ' BLOB summary');
      rejectRawAudit('safe_summary', "CAST(X'" + hex + "' AS TEXT)",
        label + ' corrupt TEXT summary');
      rejectRawAudit('target_account_ids_json', "X'" + jsonHex + "'",
        label + ' BLOB JSON');
      rejectRawAudit('target_account_ids_json', "CAST(X'" + jsonHex + "' AS TEXT)",
        label + ' corrupt TEXT JSON');
    }
    rejectRawAudit('safe_summary', "X'6F6B'", 'well-formed UTF-8 as BLOB');
    rejectRawAudit('safe_summary', "X'F09F9880'", 'valid emoji as BLOB');
    rejectRawAudit('target_account_ids_json', "X'5B5D'", 'valid JSON [] as BLOB');
    rejectRawAudit('target_account_ids_json', "CAST(X'5B5DFF' AS TEXT)",
      'JSON with corrupt trailing byte');
    rejectRawAudit('safe_summary', "'ok' || char(0) || CAST(zeroblob(300000) AS TEXT)",
      'NUL and 300KB tail in summary');
    rejectRawAudit('target_account_ids_json',
      "'[]' || char(0) || CAST(zeroblob(300000) AS TEXT)",
      'NUL and 300KB tail in JSON');
  }
  rawSqlNegativeMatrix();
  db.pragma('ignore_check_constraints = ON');
  try {
    rawSqlNegativeMatrix();
  } finally {
    db.pragma('ignore_check_constraints = OFF');
  }
  // Positive Unicode and maximum legal sizes on the *actual* SQLite engine
  // linked into better-sqlite3. Include the literal replacement character,
  // not an incorrectly encoded byte sequence that decodes to U+FFFD.
  auditWrite('[]', 'ASCII', 'OWNER');
  auditWrite('[]', '\uFFFD', 'OWNER');
  auditWrite('[]', 'Русский текст 😀', 'OWNER');
  db.exec(
    "INSERT INTO agent_activity_events(event_id,actor_type,origin,request_id," +
    "operation_id,stage,safe_summary,occurred_at) VALUES " +
    "('evt_valid_fffd','SYSTEM','SYSTEM','valid_fffd','audit.unicode'," +
    "'COMPLETED',CAST(X'EFBFBD' AS TEXT),'" + now + "')"
  );
  assert.equal(db.prepare(
    "SELECT hex(CAST(safe_summary AS BLOB)) AS bytes FROM agent_activity_events " +
    "WHERE event_id='evt_valid_fffd'").get().bytes, 'EFBFBD');
  const exact4096Json = '[' + ' '.repeat(4094) + ']';
  assert.equal(Buffer.byteLength(exact4096Json), 4096);
  const boundaryStartedAt = performance.now();
  auditWrite(exact4096Json, '😀'.repeat(240), 'OWNER');
  const boundaryMs = performance.now() - boundaryStartedAt;
  assert.ok(boundaryMs < 5000, 'maximum legal summary/JSON must complete in 5s: ' +
    boundaryMs.toFixed(1) + 'ms');


  // Simulate an already-v15 database with *old* triggers. A failed upgrade
  // halfway through DROP/CREATE must restore their original definitions.
  const legacy=new Database(':memory:');
  try {
    legacy.exec(
      "CREATE TABLE agent_activity_events ("+
      "event_id TEXT PRIMARY KEY, "+
      "target_account_ids_json TEXT NOT NULL DEFAULT '[]' "+
      "CHECK(json_valid(target_account_ids_json) AND json_type(target_account_ids_json)='array'), "+
      "safe_summary TEXT NOT NULL CHECK(length(safe_summary) BETWEEN 1 AND 240));"
    );
    legacy.pragma('user_version = 15');
    legacy.exec([
      'CREATE TRIGGER trg_agent_audit_payload_insert',
      'BEFORE INSERT ON agent_activity_events BEGIN',
      "SELECT RAISE(ABORT,'LEGACY_BLOCK_INSERT')",
      "WHERE NEW.event_id='legacy_blocked_insert'; END;",
      'CREATE TRIGGER trg_agent_audit_payload_update',
      'BEFORE UPDATE ON agent_activity_events BEGIN',
      "SELECT RAISE(ABORT,'LEGACY_BLOCK_UPDATE')",
      "WHERE NEW.event_id='legacy_blocked_update'; END;"
    ].join(' '));
    legacy.prepare('INSERT INTO agent_activity_events VALUES (?,?,?)')
      .run('legacy_good','[]','Историческое сообщение');
    // Older schemas may already contain corrupt rows. Installation must not
    // silently rewrite or delete one; later UPDATE fails closed on this row.
    legacy.exec("INSERT INTO agent_activity_events VALUES "+
      "('legacy_corrupt','[]',CAST(X'FF' AS TEXT))");
    const historicalHex = legacy.prepare(
      "SELECT hex(CAST(safe_summary AS BLOB)) AS h FROM agent_activity_events "+
      "WHERE event_id='legacy_corrupt'").get().h;
    assert.equal(historicalHex,'FF');
    const triggerDefinitions = () => legacy.prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' "+
      "AND name IN ('trg_agent_audit_payload_insert','trg_agent_audit_payload_update') "+
      "ORDER BY name").all();
    const oldTriggers = triggerDefinitions();
    assert.equal(oldTriggers.length, 2);
    const simulateBrokenInstaller = {
      transaction: legacy.transaction.bind(legacy),
      exec(sql) {
        assert.match(sql, /DROP TRIGGER IF EXISTS trg_agent_audit_payload_insert/);
        legacy.exec(sql.replace('CREATE TRIGGER trg_agent_audit_payload_update',
          'THIS_DDL_IS_INTENTIONALLY_INVALID; CREATE TRIGGER trg_agent_audit_payload_update'));
      }
    };
    assert.throws(() => ensureAgentAuditGuards(simulateBrokenInstaller),
      /syntax error|near/, 'failed trigger replacement must throw');
    assert.deepEqual(triggerDefinitions(), oldTriggers,
      'failed replacement rolls back both drops and preserves old guards');
    assert.throws(()=>legacy.prepare('INSERT INTO agent_activity_events VALUES (?,?,?)')
      .run('legacy_blocked_insert','[]','safe'),/LEGACY_BLOCK_INSERT/);
    assert.equal(legacy.prepare(
      "SELECT hex(CAST(safe_summary AS BLOB)) AS h FROM agent_activity_events "+
      "WHERE event_id='legacy_corrupt'").get().h,'FF');

    ensureAgentAuditGuards(legacy);
    const newTriggers = triggerDefinitions();
    assert.equal(newTriggers.length, 2);
    for (const item of newTriggers) {
      assert.match(item.sql, /WITH RECURSIVE utf8_reconstruction/,
        'old definitions must be replaced, not ignored');
    }
    assert.notDeepEqual(newTriggers,oldTriggers);
    assert.throws(()=>legacy.prepare('INSERT INTO agent_activity_events VALUES (?,?,?)')
      .run('legacy_bad','[null]','safe'),/AGENT_AUDIT_INVALID_TARGET_IDS/);
    assert.throws(()=>legacy.exec(
      "INSERT INTO agent_activity_events VALUES "+
      "('legacy_bad_blob',X'5B5D','safe')"),/AGENT_AUDIT_INVALID_TARGET_IDS/);
    assert.throws(()=>legacy.exec(
      "INSERT INTO agent_activity_events VALUES "+
      "('legacy_bad_utf8','[]',CAST(X'FF' AS TEXT))"),/AGENT_AUDIT_INVALID_SUMMARY/);
    assert.throws(()=>legacy.prepare('UPDATE agent_activity_events SET safe_summary=? WHERE event_id=?')
      .run('x'+String.fromCharCode(0)+'hidden','legacy_good'),
      /AGENT_AUDIT_INVALID_SUMMARY/);
    assert.throws(()=>legacy.prepare(
      "UPDATE agent_activity_events SET event_id='history_edited' WHERE event_id='legacy_corrupt'")
      .run(), /AGENT_AUDIT_INVALID_SUMMARY/,
      'a historical corrupt row must remain untouched and fail closed on unrelated UPDATE');
    assert.equal(legacy.prepare(
      "SELECT hex(CAST(safe_summary AS BLOB)) AS h FROM agent_activity_events "+
      "WHERE event_id='legacy_corrupt'").get().h,'FF');
    assert.equal(legacy.prepare('SELECT safe_summary FROM agent_activity_events WHERE event_id=?')
      .get('legacy_good').safe_summary,'Историческое сообщение');
    ensureAgentAuditGuards(legacy);
    assert.deepEqual(triggerDefinitions(),newTriggers,
      'repeated replacement must keep identical guarded SQL');
    assert.equal(Number(legacy.pragma('user_version',{simple:true})),15);
  } finally {
    legacy.close();
  }

  // Runtime migrate() repairs dropped guards on an already v15 DB.
  db.exec('DROP TRIGGER trg_agent_audit_payload_insert; DROP TRIGGER trg_agent_audit_payload_update;');
  const retainedCount=auditCount();
  migrate();
  assert.equal(auditCount(),retainedCount);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('trg_agent_audit_payload_insert','trg_agent_audit_payload_update')"
  ).get().n,2,'existing v15 migration must restore both triggers');
  rejectedAudit(()=>auditWrite('[""]','safe'),'reinstalled insert trigger');
  rejectedAudit(()=>auditUpdate.run('[]',String.fromCharCode(0)+'unsafe','evt_a1a_001'),
    'reinstalled update trigger');
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
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
    boundedAuditIds:true,unicodeSummaryAndNulProtected:true,
    existingV15TriggersInstalled:true,corruptPolicyJsonRejected:true,
    utf8RawSqlMatrix:true,atomicTriggerUpgradeRollback:true,legacyInvalidHistoryRetained:true,
    rerunSafe:true,futureSchemaRefused:true}));
} finally {
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
