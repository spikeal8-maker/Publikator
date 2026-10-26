import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-a2b1-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='agent-text-only-master-key-longer-than-thirty-two-2026';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {buildApp}=await import('../dist/app.js');
const {encryptJson}=await import('../dist/crypto.js');
const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');
const {createOwnerAgent,controlOwnerAgent}=await import('../dist/agent-owner-registry.js');
const {updateOwnerAgentGrant}=await import('../dist/agent-owner-grants.js');
const {issueOwnerMachineKey}=await import('../dist/agent-machine-keys.js');

migrate();
let app=await buildApp();
const session=createOrRecoverAdmin('INITIAL',createAdminSetupGrant('INITIAL'),
  'owner','draft-only-owner-password-2026','draft-only-owner-password-2026');
const endpoint='/api/agent/v1/posts';
const headers=(token,key='create-once')=>({
  authorization:'Bearer '+token,'idempotency-key':key
});
const send=(body,head,url=endpoint)=>app.inject({method:'POST',url,headers:head,payload:body});
const count=table=>db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;

try{
  assert.equal(Number(db.pragma('user_version',{simple:true})),18);
  const project=db.prepare('SELECT id,slug FROM projects LIMIT 1').get();
  const otherProject=id('prj');
  db.prepare('INSERT INTO projects(id,name,slug,created_at) VALUES (?,?,?,?)')
    .run(otherProject,'Other project','agent-other',nowIso());
  const a1=id('acc'),a2=id('acc'),foreign=id('acc'),disabled=id('acc');
  for(const [aid,platform,enabled] of [
    [a1,'telegram',1],[a2,'vk',1],[foreign,'max',1],[disabled,'telegram',0]
  ]){
    db.prepare('INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(aid,platform,'Fixture '+aid,encryptJson({accessToken:'secret-never-return'}),enabled,nowIso(),nowIso());
  }
  const manual=id('post');
  db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'Owner READY','manual','READY','APPROVED','MANUAL','manual',?,?)")
    .run(manual,project.id,nowIso(),nowIso());
  const one=createOwnerAgent({name:'Agent one',clientKind:'n8n'},'owner-agent-1');
  const two=createOwnerAgent({name:'Agent two',clientKind:'rest_client'},'owner-agent-2');
  const grant=(agent,prj,accounts,k)=>updateOwnerAgentGrant(agent.agentId,{
    expectedGrantVersion:1,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:['posts:write'],projectIds:[prj],accountIds:accounts,
    sourceConnectorIds:[],confirmElevation:true
  },k);
  assert.equal(grant(one,project.id,[a1,a2],'grant-one').grantVersion,2);
  assert.equal(grant(two,otherProject,[foreign],'grant-two').grantVersion,2);
  const key=(agent,k)=>issueOwnerMachineKey(agent.agentId,{
    expectedGrantVersion:2,scopeIds:['posts:write'],ttlHours:24
  },k).bearerToken;
  const token1=key(one,'token-one'),token2=key(two,'token-two');
  const initial=count('posts'),events=count('agent_activity_events');
  const body={projectId:project.id,contentFormat:'TEXT_ONLY',publicationKind:'FEED',
    internalTitle:'Test draft',bodyPlain:'Text that must stay a draft',
    targetAccountIds:[a2,a1],mediaAssetIds:[],schedule:null};
  const first=await send(body,headers(token1));
  assert.equal(first.statusCode,201,first.body);
  const data=first.json();
  assert.equal(data.status,'DRAFT');
  assert.equal(data.contentVersion,1);
  assert.equal(data.schedule,null);
  assert.deepEqual(data.targetAccountIds,[a1,a2].sort());
  assert.equal(count('posts'),initial+1);
  const post=db.prepare('SELECT * FROM posts WHERE id=?').get(data.postId);
  assert.equal(post.source_type,'agent-api');
  assert.equal(post.status,'DRAFT');
  assert.equal(post.schedule_mode,'MANUAL');
  assert.equal(post.scheduled_at_utc,null);
  const owner=db.prepare('SELECT * FROM agent_draft_ownership WHERE post_id=?').get(data.postId);
  assert.equal(owner.agent_id,one.agentId);
  assert.equal(owner.creation_grant_version,2);
  const rev=db.prepare('SELECT * FROM content_revisions WHERE post_id=?').all(data.postId);
  assert.equal(rev.length,1);
  assert.equal(rev[0].actor_source,'agent_api');
  assert.deepEqual(db.prepare('SELECT account_id FROM post_targets WHERE post_id=? ORDER BY account_id').all(data.postId)
    .map(x=>x.account_id),[a1,a2].sort());
  const receipt=db.prepare('SELECT * FROM agent_operation_receipts WHERE post_id=?').get(data.postId);
  assert.equal(receipt.phase,'COMPLETED');
  assert.equal(receipt.agent_id,one.agentId);
  assert.equal(receipt.idempotency_key_hash.length,64);
  assert.equal(count('agent_activity_events'),events+1);
  assert.ok(!JSON.stringify(receipt).includes('create-once'));
  assert.ok(!JSON.stringify(receipt).includes(token1));
  assert.ok(!first.body.includes('secret-never-return'));

  const reordered={mediaAssetIds:[],targetAccountIds:[a1,a2],
    internalTitle:body.internalTitle,projectId:project.id,
    bodyPlain:body.bodyPlain,contentFormat:'TEXT_ONLY',schedule:null,publicationKind:'FEED'};
  const replay=await send(reordered,headers(token1));
  assert.equal(replay.statusCode,200,replay.body);
  assert.deepEqual(replay.json(),data);
  assert.equal(count('posts'),initial+1);
  assert.equal(count('agent_activity_events'),events+1);
  const conflict=await send({...body,bodyPlain:'Other text'},headers(token1));
  assert.equal(conflict.statusCode,409);
  assert.equal(conflict.json().error.code,'IDEMPOTENCY_CONFLICT');

  const negatives=[
    [{...body,status:'READY'},400],
    [{...body,agentId:two.agentId},400],
    [{...body,contentFormat:'IMAGE'},403],
    [{...body,schedule:{mode:'QUEUE'}},403],
    [{...body,mediaAssetIds:['media_forbidden']},403],
    [{...body,targetTextOverrides:[{accountId:a1,bodyPlain:'replace'}]},403],
    [{...body,targetAccountIds:[a1,foreign]},403],
    [{...body,targetAccountIds:[disabled]},403],
    [{...body,projectId:otherProject},403],
    [{...body,targetAccountIds:[a1,a1]},400],
    [{...body,targetAccountIds:[]},400],
    [{...body,bodyPlain:' '},400]
  ];
  for(let i=0;i<negatives.length;i++){
    const [bad,expected]=negatives[i];
    const response=await send(bad,headers(token1,'negative-'+i));
    assert.equal(response.statusCode,expected,
      JSON.stringify({i,expected,actual:response.statusCode,body:response.body}));
  }
  assert.equal(count('posts'),initial+1);
  for(const sql of [
    "UPDATE posts SET status='READY' WHERE id=?",
    "UPDATE posts SET schedule_mode='AT' WHERE id=?",
    "UPDATE posts SET editorial_stage='APPROVED' WHERE id=?",
    "UPDATE posts SET source_type='manual' WHERE id=?"
  ])assert.throws(()=>db.prepare(sql).run(data.postId),/AGENT_OWNER_CONSENT_REQUIRED/);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(manual).status,'READY');

  assert.equal((await send(body,{})).statusCode,401);
  assert.equal((await send(body,{cookie:'publikator_session='+session})).statusCode,401);
  assert.equal((await send(body,{...headers(token1,'mixed'),cookie:'publikator_session='+session})).statusCode,401);
  assert.equal((await send(body,{authorization:'Bearer pk_'+'a'.repeat(43),
    'idempotency-key':'legacy'})).statusCode,401);
  assert.equal((await send(body,{authorization:'Bearer '+token1})).statusCode,400);
  assert.equal((await send(body,headers(token1,'evil-query'),endpoint+'?publish=true')).statusCode,400);
  assert.equal((await send(body,{...headers(token1,'origin'),origin:'https://evil.example'})).statusCode,403);

  assert.equal((await send(body,headers(token2,'foreign-post'))).statusCode,403);
  const otherBody={...body,projectId:otherProject,targetAccountIds:[foreign],
    internalTitle:'Independent draft'};
  const other=await send(otherBody,headers(token2,'create-once'));
  assert.equal(other.statusCode,201,other.body);
  assert.notEqual(other.json().postId,data.postId);
  assert.equal(db.prepare('SELECT agent_id FROM agent_draft_ownership WHERE post_id=?')
    .get(other.json().postId).agent_id,two.agentId);
  await app.close();
  app=await buildApp();
  const restart=await send(reordered,headers(token1));
  assert.equal(restart.statusCode,200,restart.body);
  assert.deepEqual(restart.json(),data);
  const revokeGrant=updateOwnerAgentGrant(one.agentId,{
    expectedGrantVersion:2,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:['posts:write'],projectIds:[project.id],accountIds:[a1],
    sourceConnectorIds:[],confirmElevation:false
  },'narrow-agent-one');
  assert.equal(revokeGrant.grantVersion,3);
  assert.equal((await send(body,headers(token1,'stale'))).statusCode,401);
  controlOwnerAgent(two.agentId,'pause',{expectedGrantVersion:2,confirm:true},'pause-two');
  assert.equal((await send(otherBody,headers(token2,'paused'))).statusCode,401);
  const log=JSON.stringify([
    ...db.prepare('SELECT * FROM agent_operation_receipts').all(),
    ...db.prepare("SELECT * FROM agent_activity_events WHERE actor_type='AGENT'").all()
  ]);
  for(const secret of [token1,token2,'secret-never-return','create-once'])
    assert.ok(!log.includes(secret));
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A2b1',schema:18,
    canonicalContentPlan:true,immutableOrigin:true,oneSafeTextDraft:true,
    scopedProjectsAccounts:true,replaySafe:true,conflict409:true,
    noReadyOrSchedule:true,noSecretLeak:true,noLiveProviderPost:true,restartSafe:true}));
}finally{
  await app.close();
  db.close();
  await fs.rm(dir,{recursive:true,force:true});
}
