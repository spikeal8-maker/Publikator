import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-agent-schema18-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='schema18-agent-provenance-master-key-long-enough-2026';
process.env.PUBLIC_BASE_URL='http://127.0.0.1:8080';

const { db,migrate,id,nowIso }=await import('../dist/db.js');
const { DATABASE_SCHEMA_VERSION }=await import('../dist/schema.js');
const { createAdminSetupGrant,createOrRecoverAdmin }=await import('../dist/admin-auth.js');
const { encryptJson,decryptJson }=await import('../dist/crypto.js');

migrate();
try {
  assert.equal(DATABASE_SCHEMA_VERSION,18);
  createOrRecoverAdmin('INITIAL',createAdminSetupGrant('INITIAL'),
    'owner','schema18-owner-password-2026','schema18-owner-password-2026');
  const time=nowIso();
  const prj=db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  const acc=id('acc'),oldPost=id('post');
  const secret={botToken:'existing-secret-never-plaintext',channel:'test'};
  const encrypted=encryptJson(secret);
  db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'telegram','Retained',?,1,?,?)")
    .run(acc,encrypted,time,time);
  db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at) VALUES (?,?,'Manual post','Unpublished fixture','READY','APPROVED','MANUAL',?,?)")
    .run(oldPost,prj,time,time);
  const before={
    admin:db.prepare('SELECT * FROM admin_users ORDER BY id').all(),
    accounts:db.prepare('SELECT * FROM social_accounts ORDER BY id').all(),
    posts:db.prepare('SELECT * FROM posts ORDER BY id').all()
  };

  db.exec([
    'DROP TRIGGER IF EXISTS trg_agent_draft_ownership_initial_safety;',
    'DROP TRIGGER IF EXISTS trg_agent_draft_ownership_immutable;',
    'DROP TRIGGER IF EXISTS trg_agent_draft_ownership_no_delete;',
    'DROP TRIGGER IF EXISTS trg_agent_draft_no_external_publish;',
    'DROP TRIGGER IF EXISTS trg_agent_draft_initial_no_publish;',
    'DROP TRIGGER IF EXISTS trg_agent_receipt_exact_owner;',
    'DROP TABLE agent_operation_receipts;',
    'DROP TABLE agent_draft_ownership;'
  ].join('\n'));
  db.pragma('user_version = 17');
  migrate();
  assert.equal(Number(db.pragma('user_version',{simple:true})),18);
  assert.deepEqual(db.prepare('SELECT * FROM admin_users ORDER BY id').all(),before.admin);
  assert.deepEqual(db.prepare('SELECT * FROM social_accounts ORDER BY id').all(),before.accounts);
  assert.deepEqual(db.prepare('SELECT * FROM posts ORDER BY id').all(),before.posts);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_draft_ownership').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_operation_receipts').get().n,0);
  assert.deepEqual(decryptJson(encrypted),secret);

  const agent=id('agent'),draft=id('post'),wrongAgent=id('agent');
  for(const aid of [agent,wrongAgent]){
    db.prepare("INSERT INTO agent_principals(id,owner_admin_id,name,client_kind,created_at,updated_at) VALUES (?,'owner','Synthetic', 'n8n',?,?)")
      .run(aid,time,time);
    db.prepare('INSERT INTO agent_grants(agent_id,created_at,updated_at) VALUES (?,?,?)')
      .run(aid,time,time);
  }
  db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'Agent draft','Editable fixture','DRAFT','DRAFT','MANUAL','agent-api',?,?)")
    .run(draft,prj,time,time);
  const provenance=db.prepare('INSERT INTO agent_draft_ownership(post_id,agent_id,creation_grant_version,creation_operation_id,created_at) VALUES (?,?,?,?,?)');
  provenance.run(draft,agent,1,'createAgentPost',time);
  const owner=db.prepare('SELECT * FROM agent_draft_ownership WHERE post_id=?').get(draft);
  assert.equal(owner.agent_id,agent);
  assert.equal(owner.creation_grant_version,1);
  assert.equal(owner.origin_kind,'AGENT_CREATED');

  for(const sql of [
    "UPDATE posts SET status='READY',editorial_stage='APPROVED' WHERE id=?",
    "UPDATE posts SET status='QUEUED' WHERE id=?",
    "UPDATE posts SET status='PUBLISHED' WHERE id=?",
    "UPDATE posts SET editorial_stage='APPROVED' WHERE id=?",
    "UPDATE posts SET schedule_mode='AT',scheduled_at='2026-10-27T10:00:00Z' WHERE id=?",
    "UPDATE posts SET schedule_mode='QUEUE' WHERE id=?",
    "UPDATE posts SET source_type='manual' WHERE id=?",
    "UPDATE posts SET scheduled_at_utc='2026-10-27T10:00:00Z' WHERE id=?"
  ]){
    assert.throws(()=>db.prepare(sql).run(draft),/AGENT_OWNER_CONSENT_REQUIRED/);
  }
  for(const [sql,values] of [
    ['UPDATE agent_draft_ownership SET post_id=? WHERE post_id=?',[id('post'),draft]],
    ['UPDATE agent_draft_ownership SET creation_grant_version=2 WHERE post_id=?',[draft]],
    ["UPDATE agent_draft_ownership SET creation_operation_id='other' WHERE post_id=?",[draft]]
  ]){
    assert.throws(()=>db.prepare(sql).run(...values),/AGENT_OWNER_IMMUTABLE/);
  }
  assert.throws(()=>db.prepare('DELETE FROM agent_draft_ownership WHERE post_id=?')
    .run(draft),/AGENT_OWNER_IMMUTABLE/);
  assert.throws(()=>db.prepare('UPDATE agent_draft_ownership SET agent_id=? WHERE post_id=?')
    .run(wrongAgent,draft),/AGENT_OWNER_IMMUTABLE/);
  assert.throws(()=>db.prepare('DELETE FROM posts WHERE id=?').run(draft),
    /FOREIGN KEY constraint|AGENT_OWNER_IMMUTABLE/);

  // Editing a normal DRAFT, including moving to safe review or trash, is
  // intentionally permitted: lifecycle safety is not blanket read-only.
  db.prepare("UPDATE posts SET body='Revised safe draft',content_version=content_version+1 WHERE id=?")
    .run(draft);
  db.prepare("UPDATE posts SET editorial_stage='IN_REVIEW' WHERE id=?").run(draft);
  db.prepare("UPDATE posts SET editorial_stage='TRASHED' WHERE id=?").run(draft);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(draft).status,'DRAFT');

  // Manual READY posts remain completely outside this new safety trigger.
  db.prepare("UPDATE posts SET title='Still manual READY' WHERE id=?").run(oldPost);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(oldPost).status,'READY');

  const badReady=id('post'),badManual=id('post'),orphan=id('post');
  // Even before an immutable ownership row is attached, a NEW agent-api post
  // cannot be inserted in a publisher-visible status (no gap in the DB guard).
  assert.throws(()=>db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'bad','x','READY','APPROVED','MANUAL','agent-api',?,?)")
    .run(badReady,prj,time,time),/AGENT_OWNER_CONSENT_REQUIRED/);
  db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'safe','x','DRAFT','DRAFT','MANUAL','agent-api',?,?)")
    .run(orphan,prj,time,time);
  assert.throws(()=>db.prepare("UPDATE posts SET status='READY' WHERE id=?").run(orphan),
    /AGENT_OWNER_CONSENT_REQUIRED/,'agent-api must be protected before ownership attach');
  db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'bad','x','DRAFT','DRAFT','MANUAL','manual',?,?)")
    .run(badManual,prj,time,time);
  assert.throws(()=>provenance.run(badManual,agent,1,'createAgentPost',time),
    /AGENT_DRAFT_ONLY/);
  assert.throws(()=>provenance.run(draft,agent,99,'createAgentPost',time),
    /AGENT_DRAFT_ONLY|UNIQUE constraint/);

  const receipt=db.prepare([
    'INSERT INTO agent_operation_receipts',
    '(receipt_id,agent_id,operation_name,idempotency_key_hash,',
    'canonical_payload_hash,post_id,phase,result_json,created_at,updated_at)',
    'VALUES (?,?,?,?,?,?,?,?,?,?)'
  ].join(' '));
  const receiptId=id('arec');
  receipt.run(receiptId,agent,'createAgentPost','a'.repeat(64),
    'b'.repeat(64),draft,'COMPLETED',
    JSON.stringify({postId:draft,contentVersion:2,status:'DRAFT'}),time,time);
  assert.equal(db.prepare('SELECT phase FROM agent_operation_receipts WHERE receipt_id=?')
    .get(receiptId).phase,'COMPLETED');
  const otherOwnedDraft=id('post');
  db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'Other agent draft','Safe','DRAFT','DRAFT','MANUAL','agent-api',?,?)")
    .run(otherOwnedDraft,prj,time,time);
  provenance.run(otherOwnedDraft,wrongAgent,1,'createAgentPost',time);
  assert.throws(()=>db.prepare('UPDATE agent_operation_receipts SET post_id=? WHERE receipt_id=?')
    .run(otherOwnedDraft,receiptId),/AGENT_RECEIPT_FOREIGN_POST|AGENT_RECEIPT_IMMUTABLE/);
  assert.throws(()=>db.prepare('UPDATE agent_operation_receipts SET agent_id=? WHERE receipt_id=?')
    .run(wrongAgent,receiptId),/AGENT_RECEIPT_FOREIGN_POST|AGENT_RECEIPT_IMMUTABLE/);
  assert.throws(()=>db.prepare('UPDATE agent_operation_receipts SET idempotency_key_hash=? WHERE receipt_id=?')
    .run('0'.repeat(64),receiptId),/AGENT_RECEIPT_IMMUTABLE/);
  assert.throws(()=>db.prepare('UPDATE agent_operation_receipts SET result_json=? WHERE receipt_id=?')
    .run(JSON.stringify({postId:otherOwnedDraft,status:'DRAFT'}),receiptId),
    /AGENT_RECEIPT_IMMUTABLE|CHECK constraint/);
  assert.throws(()=>db.prepare('DELETE FROM agent_operation_receipts WHERE receipt_id=?')
    .run(receiptId),/AGENT_RECEIPT_IMMUTABLE/);
  assert.throws(()=>receipt.run(id('arec'),agent,'createAgentPost',
    '5'.repeat(64),'6'.repeat(64),draft,'COMPLETED',
    JSON.stringify({postId:draft,status:'DRAFT',botToken:secret.botToken}),time,time),
    /CHECK constraint/,'secret-bearing response must not be stored');
  assert.throws(()=>receipt.run(id('arec'),agent,'createAgentPost',
    '7'.repeat(64),'8'.repeat(64),draft,'COMPLETED',
    JSON.stringify({postId:otherOwnedDraft,status:'DRAFT'}),time,time),
    /CHECK constraint/,'result postId must match the owned post');
  assert.throws(()=>receipt.run(id('arec'),agent,'createAgentPost',
    '9'.repeat(64),'0'.repeat(64),draft,'COMPLETED',
    JSON.stringify({status:'DRAFT'}),time,time),
    /CHECK constraint/,'completed response requires postId');
  const pendingReceipt=id('arec');
  receipt.run(pendingReceipt,agent,'createAgentPost','2'.repeat(64),
    '3'.repeat(64),null,'CLAIMED',null,time,time);
  assert.throws(()=>db.prepare("UPDATE agent_operation_receipts SET phase='COMPLETED',post_id=?,result_json=? WHERE receipt_id=?")
    .run(otherOwnedDraft,JSON.stringify({postId:otherOwnedDraft,status:'DRAFT'}),
      pendingReceipt),/AGENT_RECEIPT_FOREIGN_POST/,
    'a pending receipt cannot be reassigned to another agent post');
  db.prepare("UPDATE agent_operation_receipts SET phase='COMPLETED',post_id=?,result_json=? WHERE receipt_id=?")
    .run(draft,JSON.stringify({postId:draft,status:'DRAFT',contentVersion:2}),
      pendingReceipt);
  assert.equal(db.prepare('SELECT phase FROM agent_operation_receipts WHERE receipt_id=?')
    .get(pendingReceipt).phase,'COMPLETED');
  assert.throws(()=>receipt.run(id('arec'),wrongAgent,'createAgentPost',
    'e'.repeat(64),'f'.repeat(64),draft,'COMPLETED',
    JSON.stringify({postId:draft,status:'DRAFT'}),time,time),
    /AGENT_RECEIPT_FOREIGN_POST/,'a foreign agent cannot claim the draft receipt');
  assert.throws(()=>receipt.run(id('arec'),agent,'createAgentPost','a'.repeat(64),
    'c'.repeat(64),draft,'COMPLETED',
    JSON.stringify({postId:draft,status:'DRAFT'}),time,time),/UNIQUE constraint/);
  assert.throws(()=>receipt.run(id('arec'),agent,'createAgentPost','not-a-hash',
    'c'.repeat(64),draft,'COMPLETED','{"safe":true}',time,time),/CHECK constraint/);
  assert.throws(()=>receipt.run(id('arec'),agent,'editAgentPost','c'.repeat(64),
    'd'.repeat(64),null,'COMPLETED','{"safe":true}',time,time),/CHECK constraint/);
  assert.throws(()=>receipt.run(id('arec'),agent,'editAgentPost','c'.repeat(64),
    'd'.repeat(64),draft,'COMPLETED','{"broken"',time,time),
    /CHECK constraint|malformed JSON/);

  const snapshot={
    ownership:db.prepare('SELECT * FROM agent_draft_ownership ORDER BY post_id').all(),
    receipts:db.prepare('SELECT * FROM agent_operation_receipts ORDER BY receipt_id').all()
  };
  migrate();
  assert.deepEqual(db.prepare('SELECT * FROM agent_draft_ownership ORDER BY post_id').all(),
    snapshot.ownership);
  assert.deepEqual(db.prepare('SELECT * FROM agent_operation_receipts ORDER BY receipt_id').all(),
    snapshot.receipts);
  assert.ok(!JSON.stringify(snapshot).includes(secret.botToken));
  db.pragma('user_version = 19');
  assert.throws(()=>migrate(),/новее поддерживаемой 18/);
  db.pragma('user_version = 18');
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A2b0',from:17,to:18,
    manualReadyPreserved:true,encryptedProviderCredentialsPreserved:true,
    immutableAgentOwnership:true,allPublisherStatusChangesBlocked:true,
    safeDraftEditingAllowed:true,idempotencyUnique:true,
    rerunSafe:true,futureSchemaRejected:true}));
}finally{
  db.close();await fs.rm(dataDir,{recursive:true,force:true});
}
