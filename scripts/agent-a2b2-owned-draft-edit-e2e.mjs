import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-agent-a2b2-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='agent-a2b2-strong-test-master-key-never-a-machine-token';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {buildApp}=await import('../dist/app.js');
const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');
const {encryptJson}=await import('../dist/crypto.js');
const {createOwnerAgent,controlOwnerAgent}=await import('../dist/agent-owner-registry.js');
const {updateOwnerAgentGrant}=await import('../dist/agent-owner-grants.js');
const {issueOwnerMachineKey}=await import('../dist/agent-machine-keys.js');

migrate();
let app=await buildApp();
const owner=createOrRecoverAdmin('INITIAL',createAdminSetupGrant('INITIAL'),
  'owner','a2b2-owner-strong-password-2026','a2b2-owner-strong-password-2026');
const h=(token,key='a2b2-edit-first')=>({authorization:'Bearer '+token,'idempotency-key':key});
const call=(method,url,body,headers={})=>app.inject({
  method,url,headers,...(body===undefined?{}:{payload:body})
});
const n=table=>db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
const postRow=postId=>db.prepare('SELECT * FROM posts WHERE id=?').get(postId);

try {
  assert.equal(Number(db.pragma('user_version',{simple:true})),18);
  const main=db.prepare('SELECT id FROM projects LIMIT 1').get().id,foreignProject=id('prj');
  db.prepare('INSERT INTO projects(id,name,slug,created_at) VALUES (?,?,?,?)')
    .run(foreignProject,'Foreign draft project','a2b2-foreign',nowIso());
  const acc1=id('acc'),acc2=id('acc'),foreignAccount=id('acc'),disabled=id('acc');
  for(const [aid,platform,enabled] of [
    [acc1,'telegram',1],[acc2,'vk',1],[foreignAccount,'max',1],[disabled,'vk',0]
  ]){
    db.prepare('INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(aid,platform,'Account '+aid,encryptJson({token:'secret-provider-do-not-emit'}),
        enabled,nowIso(),nowIso());
  }
  const first=createOwnerAgent({name:'A2b2 text editor',clientKind:'n8n'},'a2b2-new-first');
  const second=createOwnerAgent({name:'Foreign text editor',clientKind:'rest_client'},'a2b2-new-second');
  const readonly=createOwnerAgent({name:'Read-only other',clientKind:'n8n'},'a2b2-new-readonly');
  const sameScope=createOwnerAgent({name:'Same scope, different owner',clientKind:'n8n'},'a2b2-same-scope');
  const grant=(a,scopes,projectId,accIds,key)=>updateOwnerAgentGrant(a.agentId,{
    expectedGrantVersion:1,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:scopes,projectIds:[projectId],accountIds:accIds,
    sourceConnectorIds:[],confirmElevation:true
  },key);
  assert.equal(grant(first,['posts:write'],main,[acc1,acc2],'a2b2-grant-first').grantVersion,2);
  assert.equal(grant(second,['posts:write'],foreignProject,[foreignAccount],'a2b2-grant-second').grantVersion,2);
  assert.equal(grant(readonly,['posts:read'],main,[acc1],'a2b2-grant-readonly').grantVersion,2);
  assert.equal(grant(sameScope,['posts:write'],main,[acc1,acc2],'a2b2-grant-same-scope').grantVersion,2);
  const token=(a,scope,key)=>issueOwnerMachineKey(a.agentId,{
    expectedGrantVersion:2,scopeIds:[scope],ttlHours:24
  },key).bearerToken;
  const key1=token(first,'posts:write','a2b2-machine-first');
  const key2=token(second,'posts:write','a2b2-machine-second');
  const keyRead=token(readonly,'posts:read','a2b2-machine-read');
  const keySameScope=token(sameScope,'posts:write','a2b2-machine-same-scope');
  const created=await call('POST','/api/agent/v1/posts',{
    projectId:main,contentFormat:'TEXT_ONLY',publicationKind:'FEED',
    internalTitle:'Original heading',bodyPlain:'Original body',
    targetAccountIds:[acc2,acc1],mediaAssetIds:[],schedule:null
  },h(key1,'a2b2-create'));
  assert.equal(created.statusCode,201,created.body);
  const initial=created.json(),pid=initial.postId,api='/api/agent/v1/posts/'+pid;
  assert.equal(initial.contentVersion,1);
  const initialEvents=n('agent_activity_events'),initialReceipts=n('agent_operation_receipts');
  const originalTargetIds=db.prepare('SELECT account_id FROM post_targets WHERE post_id=? ORDER BY account_id')
    .all(pid).map(x=>x.account_id);
  assert.deepEqual(originalTargetIds,[acc1,acc2].sort());

  const firstEdit={expectedContentVersion:1,internalTitle:'Second heading',bodyPlain:'Second body'};
  const integrity=()=>({
    post:postRow(pid),
    targetCount:n('post_targets'),
    revisions:n('content_revisions'),
    receipts:n('agent_operation_receipts'),
    activity:n('agent_activity_events'),
    publications:n('publication_units')
  });
  const beforeInjectedFailure=integrity();
  // Prove the outer BEGIN IMMEDIATE and nested canonical content transaction
  // roll back as a unit when receipt or activity insertion aborts.
  for (const [table,condition] of [
    ['agent_operation_receipts',"NEW.operation_name='updateAgentPost'"],
    ['agent_activity_events',"NEW.operation_id='updateAgentPost'"]
  ]) {
    db.exec(`CREATE TEMP TRIGGER a2b2_forced_abort BEFORE INSERT ON ${table}
      WHEN ${condition} BEGIN SELECT RAISE(ABORT,'A2B2_FORCED_ABORT'); END;`);
    try {
      const fail=await call('PATCH',api,firstEdit,h(key1,'rollback-'+table));
      assert.equal(fail.statusCode,500,fail.body);
      assert.equal(fail.json().error.code,'INTERNAL_ERROR');
      assert.deepEqual(integrity(),beforeInjectedFailure,
        'all rows and the working post must survive failed '+table);
    } finally {
      db.exec('DROP TRIGGER a2b2_forced_abort;');
    }
  }
  const updated=await call('PATCH',api,firstEdit,h(key1));
  assert.equal(updated.statusCode,200,updated.body);
  const secondVersion=updated.json();
  assert.deepEqual({
    postId:secondVersion.postId,title:secondVersion.internalTitle,
    text:secondVersion.bodyPlain,version:secondVersion.contentVersion,status:secondVersion.status
  },{postId:pid,title:'Second heading',text:'Second body',version:2,status:'DRAFT'});
  assert.deepEqual(secondVersion.targetAccountIds,originalTargetIds);
  assert.equal(n('agent_operation_receipts'),initialReceipts+1);
  assert.equal(n('agent_activity_events'),initialEvents+1);
  assert.equal(postRow(pid).status,'DRAFT');
  assert.equal(postRow(pid).editorial_stage,'DRAFT');
  assert.equal(postRow(pid).schedule_mode,'MANUAL');
  assert.equal(postRow(pid).source_type,'agent-api');
  const versions=()=>db.prepare('SELECT * FROM content_revisions WHERE post_id=? ORDER BY content_version').all(pid);
  assert.deepEqual(versions().map(v=>v.content_version),[1,2]);
  assert.equal(versions()[1].actor_source,'agent_api');
  assert.equal(versions()[0].body,'Original body','first revision is immutable');
  assert.equal(versions()[1].body,'Second body');
  const receipt=db.prepare('SELECT * FROM agent_operation_receipts WHERE post_id=? AND operation_name=?')
    .get(pid,'updateAgentPost');
  assert.deepEqual(JSON.parse(receipt.result_json),{
    postId:pid,contentVersion:2,status:'DRAFT'
  });
  assert.ok(!JSON.stringify(receipt).includes('Second body'));
  assert.ok(!JSON.stringify(receipt).includes(key1));
  assert.ok(!JSON.stringify(receipt).includes('a2b2-edit-first'));

  // Canonical key order does not change original result or write audit again.
  const again=await call('PATCH',api,{
    bodyPlain:'Second body',expectedContentVersion:1,internalTitle:'Second heading'
  },h(key1));
  assert.equal(again.statusCode,200,again.body);
  assert.deepEqual(again.json(),secondVersion);
  assert.equal(postRow(pid).content_version,2);
  assert.equal(n('agent_activity_events'),initialEvents+1);
  const conflict=await call('PATCH',api,
    {expectedContentVersion:1,bodyPlain:'Different same-key text'},h(key1));
  assert.equal(conflict.statusCode,409,conflict.body);
  assert.equal(conflict.json().error.code,'IDEMPOTENCY_CONFLICT');

  const third=await call('PATCH',api,{expectedContentVersion:2,internalTitle:'Only new title'},
    h(key1,'a2b2-title-only'));
  assert.equal(third.statusCode,200,third.body);
  assert.equal(third.json().bodyPlain,'Second body');
  assert.equal(third.json().contentVersion,3);
  assert.equal(third.json().internalTitle,'Only new title');
  const fourth=await call('PATCH',api,{bodyPlain:'Only new body',expectedContentVersion:3},
    h(key1,'a2b2-body-only'));
  assert.equal(fourth.statusCode,200,fourth.body);
  assert.equal(fourth.json().internalTitle,'Only new title');
  assert.equal(fourth.json().contentVersion,4);
  assert.deepEqual(versions().map(v=>v.content_version),[1,2,3,4]);
  assert.equal(versions().slice(1).every(v=>v.actor_source==='agent_api'),true);
  const replayOld=await call('PATCH',api,firstEdit,h(key1));
  assert.equal(replayOld.statusCode,200,replayOld.body);
  assert.deepEqual(replayOld.json(),secondVersion,
    'original version 2 must replay even after later version 4 changes');
  assert.equal(postRow(pid).content_version,4);
  assert.equal(n('agent_activity_events'),initialEvents+3);
  assert.equal((await call('PATCH',api,{expectedContentVersion:1,bodyPlain:'stale'},
    h(key1,'stale-other-key'))).statusCode,409);
  const sameTitle=await call('PATCH',api,{expectedContentVersion:4,internalTitle:'Only new title'},
    h(key1,'noop-title'));
  assert.equal(sameTitle.statusCode,400);

  const bad=[
    [{expectedContentVersion:4,status:'READY',bodyPlain:'bad'},403],
    [{expectedContentVersion:4,projectId:foreignProject,bodyPlain:'bad'},403],
    [{expectedContentVersion:4,agentId:second.agentId,bodyPlain:'bad'},403],
    [{expectedContentVersion:4,bodyRich:{unsafe:true},bodyPlain:'bad'},403],
    [{expectedContentVersion:4,targetAccountIds:[foreignAccount],bodyPlain:'bad'},403],
    [{expectedContentVersion:4,schedule:{mode:'AT'},bodyPlain:'bad'},403],
    [{expectedContentVersion:4,mediaAssetIds:[id('media')],bodyPlain:'bad'},403],
    [{expectedContentVersion:4},400],
    [{expectedContentVersion:0,bodyPlain:'bad'},400],
    [{expectedContentVersion:4,bodyPlain:' '},400],
    [{expectedContentVersion:4,bodyPlain:'X'.repeat(20001)},400],
    [{expectedContentVersion:4,internalTitle:' '},400]
  ];
  for(let i=0;i<bad.length;i++){
    const [draft,expected]=bad[i];
    const response=await call('PATCH',api,draft,h(key1,'invalid-edit-'+i));
    assert.equal(response.statusCode,expected,JSON.stringify({i,body:response.body}));
  }
  assert.equal(postRow(pid).content_version,4);
  assert.equal(n('agent_activity_events'),initialEvents+3);

  // No other agent or legacy owner cookie gains access to this draft.
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'foreign'},
    h(key2,'foreign-post'))).statusCode,404);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'read-only'},
    h(keyRead,'read-only'))).statusCode,404);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'same grant different owner'},
    h(keySameScope,'same-scope-foreign'))).statusCode,404,
    'identical project/account grants do not transfer draft ownership');
  const legacy=id('post');
  db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'Legacy','manual','DRAFT','DRAFT','MANUAL','manual',?,?)")
    .run(legacy,main,nowIso(),nowIso());
  assert.equal((await call('PATCH','/api/agent/v1/posts/'+legacy,{
    expectedContentVersion:1,bodyPlain:'manual hijack'
  },h(key1,'manual-post'))).statusCode,404);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'no auth'})).statusCode,401);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'owner cookie'},
    {cookie:'publikator_session='+owner})).statusCode,401);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'legacy key'},
    {authorization:'Bearer pk_'+'x'.repeat(43),'idempotency-key':'legacy'})).statusCode,401);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'mixed'},
    {...h(key1,'mixed'),cookie:'publikator_session='+owner})).statusCode,401);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'bad-origin'},
    {...h(key1,'bad-origin'),origin:'https://attacker.example'})).statusCode,403);
  assert.equal((await call('PATCH',api+'?status=READY',
    {expectedContentVersion:4,bodyPlain:'query'},h(key1,'query'))).statusCode,400);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'no-key'},
    {authorization:'Bearer '+key1})).statusCode,400);
  assert.equal((await call('GET',api,undefined,h(key1,'no-read-route'))).statusCode,403);

  // The existing agent provenance remains immutable; no external provider claim.
  assert.throws(()=>db.prepare("UPDATE posts SET status='READY' WHERE id=?").run(pid),
    /AGENT_OWNER_CONSENT_REQUIRED/);
  assert.throws(()=>db.prepare("UPDATE posts SET schedule_mode='AT' WHERE id=?").run(pid),
    /AGENT_OWNER_CONSENT_REQUIRED/);
  assert.throws(()=>db.prepare('DELETE FROM agent_draft_ownership WHERE post_id=?')
    .run(pid),/AGENT_OWNER_IMMUTABLE/);

  await app.close();app=await buildApp();
  const afterRestart=await call('PATCH',api,firstEdit,h(key1));
  assert.equal(afterRestart.statusCode,200,afterRestart.body);
  assert.deepEqual(afterRestart.json(),secondVersion);

  // Concurrent revisions use optimistic expectedContentVersion: exactly one
  // request can win a race on the same draft and the second receives HTTP 409.
  const draftPayload=(projectId,accounts,suffix)=>({
    projectId,contentFormat:'TEXT_ONLY',publicationKind:'FEED',
    internalTitle:'Fixture '+suffix,bodyPlain:'Safe draft '+suffix,
    targetAccountIds:accounts,mediaAssetIds:[],schedule:null
  });
  async function createExtra(tokenValue,projectId,accounts,suffix){
    const r=await call('POST','/api/agent/v1/posts',
      draftPayload(projectId,accounts,suffix),h(tokenValue,'extra-create-'+suffix));
    assert.equal(r.statusCode,201,r.body);
    return r.json().postId;
  }
  const concurrentPid=await createExtra(key1,main,[acc1,acc2],'version-concurrency');
  const concurrentUrl='/api/agent/v1/posts/'+concurrentPid;
  const racingVersion=await Promise.all([
    call('PATCH',concurrentUrl,{expectedContentVersion:1,bodyPlain:'Version contender A'},
      h(key1,'concurrent-version-a')),
    call('PATCH',concurrentUrl,{expectedContentVersion:1,bodyPlain:'Version contender B'},
      h(key1,'concurrent-version-b'))
  ]);
  assert.deepEqual(racingVersion.map(r=>r.statusCode).sort(),[200,409],
    'only one PATCH may change a given content version');
  assert.equal(postRow(concurrentPid).content_version,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_revisions WHERE post_id=?')
    .get(concurrentPid).n,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_operation_receipts WHERE post_id=? AND operation_name=?')
    .get(concurrentPid,'updateAgentPost').n,1);

  // Two agents may hold identical resource grants yet never edit one
  // another's owned draft.
  const peerPost=await createExtra(keySameScope,main,[acc1,acc2],'peer-own-draft');
  assert.equal((await call('PATCH','/api/agent/v1/posts/'+peerPost,
    {expectedContentVersion:1,bodyPlain:'Not owned by the first agent'},
    h(key1,'peer-denied'))).statusCode,404);
  assert.equal((await call('PATCH','/api/agent/v1/posts/'+peerPost,
    {expectedContentVersion:1,bodyPlain:'Edited only by its owner'},
    h(keySameScope,'peer-owned'))).statusCode,200);

  // Four real first-agent edits plus 115 completed synthetic receipts bring
  // the budget to 119/120. Five concurrent PATCH requests on DIFFERENT
  // drafts must yield one success and four rate-limited responses.
  const quotaPostIds=[];
  for(let i=0;i<5;i++)quotaPostIds.push(
    await createExtra(key1,main,[acc1,acc2],'quota-'+i));
  const insertBudget=db.prepare([
    'INSERT INTO agent_operation_receipts',
    '(receipt_id,agent_id,operation_name,idempotency_key_hash,',
    'canonical_payload_hash,post_id,phase,result_json,created_at,updated_at)',
    'VALUES (?,?,?,?,?,?,?,?,?,?)'
  ].join(' '));
  db.transaction(()=>{
    for(let i=1;i<=115;i++){
      insertBudget.run(id('arec'),first.agentId,'updateAgentPost',
        i.toString(16).padStart(64,'0'),'f'.repeat(64),pid,
        'COMPLETED',JSON.stringify({
          postId:pid,contentVersion:4,status:'DRAFT'
        }),nowIso(),nowIso());
    }
  }).immediate();
  const firstAgentReceipts=()=>db.prepare(
    "SELECT COUNT(*) AS n FROM agent_operation_receipts WHERE agent_id=? AND operation_name='updateAgentPost' AND phase='COMPLETED'"
  ).get(first.agentId).n;
  assert.equal(firstAgentReceipts(),119);
  const beforeRace={revisions:n('content_revisions'),receipts:n('agent_operation_receipts'),
    events:n('agent_activity_events')};
  const quotaRace=await Promise.all(quotaPostIds.map((p,i)=>
    call('PATCH','/api/agent/v1/posts/'+p,
      {expectedContentVersion:1,bodyPlain:'Quota contender '+i},
      h(key1,'quota-race-'+i))));
  const winners=quotaRace.flatMap((r,i)=>r.statusCode===200?[i]:[]);
  assert.equal(winners.length,1,'exactly one new edit at quota 119/120');
  assert.equal(quotaRace.filter(r=>r.statusCode===429).length,4);
  for(const r of quotaRace.filter(r=>r.statusCode===429)) {
    assert.equal(r.json().error.code,'RATE_LIMITED');
    assert.equal(r.headers['retry-after'],'3600');
  }
  assert.equal(firstAgentReceipts(),120);
  assert.equal(n('content_revisions'),beforeRace.revisions+1);
  assert.equal(n('agent_operation_receipts'),beforeRace.receipts+1);
  assert.equal(n('agent_activity_events'),beforeRace.events+1);
  const winner=winners[0];
  const winnerReplay=await call('PATCH','/api/agent/v1/posts/'+quotaPostIds[winner],
    {expectedContentVersion:1,bodyPlain:'Quota contender '+winner},
    h(key1,'quota-race-'+winner));
  assert.equal(winnerReplay.statusCode,200);
  assert.deepEqual(winnerReplay.json(),quotaRace[winner].json());
  assert.equal(firstAgentReceipts(),120,'replay must not consume another edit');
  assert.deepEqual((await call('PATCH',api,firstEdit,h(key1))).json(),secondVersion);
  assert.equal(postRow(pid).content_version,4);
  await app.close();app=await buildApp();
  const limited=await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'Blocked after restart'},
    h(key1,'a2b2-quota-after-restart'));
  assert.equal(limited.statusCode,429,limited.body);
  assert.equal(limited.json().error.code,'RATE_LIMITED');
  assert.equal(limited.headers['retry-after'],'3600');
  assert.equal((await call('PATCH','/api/agent/v1/posts/'+quotaPostIds[winner],
    {expectedContentVersion:1,bodyPlain:'Quota contender '+winner},
    h(key1,'quota-race-'+winner))).statusCode,200);
  assert.equal(firstAgentReceipts(),120);
  const otherPost=await createExtra(key2,foreignProject,[foreignAccount],'independent-agent');
  assert.equal((await call('PATCH','/api/agent/v1/posts/'+otherPost,
    {expectedContentVersion:1,bodyPlain:'Other agent still has its own quota'},
    h(key2,'independent-agent-edit'))).statusCode,200);

  // SQL-level ACL rechecks prohibit editing after an account is disabled.
  db.prepare('UPDATE social_accounts SET enabled=0 WHERE id=?').run(acc2);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'Disabled target'},
    h(key1,'target-disabled'))).statusCode,409);
  db.prepare('UPDATE social_accounts SET enabled=1 WHERE id=?').run(acc2);
  // Expiry, explicit revoke and token-version rotation must invalidate
  // credentials even if an old idempotency receipt exists.
  const expiredKey=issueOwnerMachineKey(first.agentId,{
    expectedGrantVersion:2,scopeIds:['posts:write'],ttlHours:24
  },'a2b2-extra-expired');
  db.prepare('UPDATE agent_machine_keys SET expires_at=? WHERE id=?')
    .run('2000-01-01T00:00:00.000Z',expiredKey.machineKey.keyId);
  assert.equal((await call('PATCH',api,firstEdit,
    h(expiredKey.bearerToken,'expired-key'))).statusCode,401);
  const revokedKey=issueOwnerMachineKey(first.agentId,{
    expectedGrantVersion:2,scopeIds:['posts:write'],ttlHours:24
  },'a2b2-extra-revoked');
  db.prepare('UPDATE agent_machine_keys SET revoked_at=? WHERE id=?')
    .run(nowIso(),revokedKey.machineKey.keyId);
  assert.equal((await call('PATCH',api,firstEdit,
    h(revokedKey.bearerToken,'revoked-key'))).statusCode,401);
  const narrowed=updateOwnerAgentGrant(first.agentId,{
    expectedGrantVersion:2,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:['posts:write'],projectIds:[main],accountIds:[acc1],
    sourceConnectorIds:[],confirmElevation:false
  },'a2b2-narrow');
  assert.equal(narrowed.grantVersion,3);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'Stale token'},
    h(key1,'stale-token'))).statusCode,401);
  db.prepare('UPDATE agent_principals SET token_version=token_version+1 WHERE id=?')
    .run(sameScope.agentId);
  assert.equal((await call('PATCH','/api/agent/v1/posts/'+peerPost,
    {expectedContentVersion:2,bodyPlain:'Stale tokenVersion'},
    h(keySameScope,'peer-stale-version'))).statusCode,401);
  controlOwnerAgent(second.agentId,'pause',
    {expectedGrantVersion:2,confirm:true},'a2b2-pause-other');
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'Paused'},
    h(key2,'paused-token'))).statusCode,401);

  // Neither raw credentials, idempotency keys nor duplicated post body
  // belong in durable operation receipts or server-authored activity.
  const logs=JSON.stringify([
    ...db.prepare('SELECT * FROM agent_operation_receipts').all(),
    ...db.prepare("SELECT * FROM agent_activity_events WHERE actor_type='AGENT'").all()
  ]);
  for(const secret of [key1,key2,keySameScope,owner,'secret-provider-do-not-emit',
    'a2b2-edit-first','Second body','Quota contender 0','Version contender A']) {
    assert.ok(!logs.includes(secret));
  }
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A2b2',
    editedViaCanonicalRevision:true,expectedVersionRequired:true,
    immutableHistory:true,originalResponseReplay:true,rateGate:true,
    forcedReceiptAndAuditRollback:true,concurrentVersion409:true,
    concurrentQuota429:true,quotaRestartSafe:true,crossAgentQuotaIsolation:true,
    revokedExpiredAndStaleTokenDenied:true,
    exactPostOwnerAndTargetAcl:true,noMediaNoPublisher:true,
    noSecretsOrPostTextInReceipts:true,disabledTargetDenied:true,
    staleGrantDenied:true,crossAgentDenied:true,restartSafe:true}));
} finally {
  await app.close();db.close();
  await fs.rm(dir,{recursive:true,force:true});
}
