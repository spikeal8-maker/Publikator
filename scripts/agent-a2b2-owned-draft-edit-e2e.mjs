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
  const grant=(a,scopes,projectId,accIds,key)=>updateOwnerAgentGrant(a.agentId,{
    expectedGrantVersion:1,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:scopes,projectIds:[projectId],accountIds:accIds,
    sourceConnectorIds:[],confirmElevation:true
  },key);
  assert.equal(grant(first,['posts:write'],main,[acc1,acc2],'a2b2-grant-first').grantVersion,2);
  assert.equal(grant(second,['posts:write'],foreignProject,[foreignAccount],'a2b2-grant-second').grantVersion,2);
  assert.equal(grant(readonly,['posts:read'],main,[acc1],'a2b2-grant-readonly').grantVersion,2);
  const token=(a,scope,key)=>issueOwnerMachineKey(a.agentId,{
    expectedGrantVersion:2,scopeIds:[scope],ttlHours:24
  },key).bearerToken;
  const key1=token(first,'posts:write','a2b2-machine-first');
  const key2=token(second,'posts:write','a2b2-machine-second');
  const keyRead=token(readonly,'posts:read','a2b2-machine-read');
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
    postId:pid,projectId:main,contentVersion:2,
    revisionId:versions()[1].id,status:'DRAFT'
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

  // The hourly edit quota counts only successful new operations, not replays.
  // Three actual edits plus 117 safe synthetic same-agent completed receipts.
  const insertBudget=db.prepare([
    'INSERT INTO agent_operation_receipts',
    '(receipt_id,agent_id,operation_name,idempotency_key_hash,',
    'canonical_payload_hash,post_id,phase,result_json,created_at,updated_at)',
    'VALUES (?,?,?,?,?,?,?,?,?,?)'
  ].join(' '));
  const lastRevision=versions()[3];
  db.transaction(()=>{
    for(let i=1;i<=117;i++){
      insertBudget.run(id('arec'),first.agentId,'updateAgentPost',
        i.toString(16).padStart(64,'0'),'f'.repeat(64),pid,
        'COMPLETED',JSON.stringify({
          postId:pid,projectId:main,contentVersion:4,
          revisionId:lastRevision.id,status:'DRAFT'
        }),nowIso(),nowIso());
    }
  }).immediate();
  const limited=await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'Blocked by hourly quota'},
    h(key1,'a2b2-quota-block'));
  assert.equal(limited.statusCode,429,limited.body);
  assert.equal(limited.json().error.code,'RATE_LIMITED');
  assert.equal(limited.headers['retry-after'],'3600');
  assert.deepEqual((await call('PATCH',api,firstEdit,h(key1))).json(),secondVersion);
  assert.equal(postRow(pid).content_version,4);

  // SQL-level ACL rechecks prohibit editing after an account is disabled.
  db.prepare('UPDATE social_accounts SET enabled=0 WHERE id=?').run(acc2);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'Disabled target'},
    h(key1,'target-disabled'))).statusCode,409);
  db.prepare('UPDATE social_accounts SET enabled=1 WHERE id=?').run(acc2);
  const narrowed=updateOwnerAgentGrant(first.agentId,{
    expectedGrantVersion:2,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:['posts:write'],projectIds:[main],accountIds:[acc1],
    sourceConnectorIds:[],confirmElevation:false
  },'a2b2-narrow');
  assert.equal(narrowed.grantVersion,3);
  assert.equal((await call('PATCH',api,{expectedContentVersion:4,bodyPlain:'Stale token'},
    h(key1,'stale-token'))).statusCode,401);
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
  for(const secret of [key1,key2,owner,'secret-provider-do-not-emit',
    'a2b2-edit-first','Second body']) {
    assert.ok(!logs.includes(secret));
  }
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A2b2',
    editedViaCanonicalRevision:true,expectedVersionRequired:true,
    immutableHistory:true,originalResponseReplay:true,rateGate:true,
    exactPostOwnerAndTargetAcl:true,noMediaNoPublisher:true,
    noSecretsOrPostTextInReceipts:true,disabledTargetDenied:true,
    staleGrantDenied:true,crossAgentDenied:true,restartSafe:true}));
} finally {
  await app.close();db.close();
  await fs.rm(dir,{recursive:true,force:true});
}
