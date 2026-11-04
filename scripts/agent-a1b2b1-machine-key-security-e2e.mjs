import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-agent-machine-api-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='agent-machine-api-master-key-do-not-share-with-bots-2026';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';
const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {buildApp}=await import('../dist/app.js');
const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');
const {createSessionToken}=await import('../dist/crypto.js');
const {createOwnerAgent,controlOwnerAgent}=await import('../dist/agent-owner-registry.js');
const {updateOwnerAgentGrant}=await import('../dist/agent-owner-grants.js');
const {
  authenticateAgentMachineKey,authorizeAgentMachineOperation
}=await import('../dist/agent-machine-keys.js');

migrate();
let app=await buildApp();
const session=createOrRecoverAdmin('INITIAL',createAdminSetupGrant('INITIAL'),
  'machine_owner','machine-owner-password-2026','machine-owner-password-2026');
const cookie='publikator_session='+session,origin='https://publisher.example.test';
const owner={cookie,origin};
const headers=(key)=>({...owner,'idempotency-key':key});
async function send(method,url,body,h={}){
  return app.inject({method,url,headers:h,...(body===undefined?{}:{payload:body})});
}
function count(table){return db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;}
function denied(fn,code='UNAUTHORIZED'){
  assert.throws(fn,(err)=>err?.code===code,code+' denial expected');
}
try{
  const prj=db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  const secondProject=id('prj');
  db.prepare('INSERT INTO projects(id,name,slug,created_at) VALUES (?,?,?,?)')
    .run(secondProject,'Blocked project','blocked-machine',nowIso());
  const n8n=createOwnerAgent({name:'Headless n8n bot',clientKind:'n8n'},'machine-create-n8n');
  const chatgpt=createOwnerAgent({name:'ChatGPT via OAuth',clientKind:'chatgpt'},'machine-create-gpt');
  const helper=createOwnerAgent({name:'Second n8n bot',clientKind:'n8n'},'machine-create-helper');
  const grant=(agentId,scopeIds,projectIds,key)=>updateOwnerAgentGrant(agentId,{
    expectedGrantVersion:1,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds,projectIds,accountIds:[],sourceConnectorIds:[],confirmElevation:true
  },key);
  assert.equal(grant(n8n.agentId,['projects:read','posts:read'],[prj],'machine-grant-n8n').grantVersion,2);
  assert.equal(grant(helper.agentId,['projects:read'],[secondProject],'machine-grant-helper').grantVersion,2);
  assert.equal(grant(chatgpt.agentId,['projects:read'],[prj],'machine-grant-chatgpt').grantVersion,2);

  const root='/api/owner/agents/'+n8n.agentId+'/machine-keys';
  const body={expectedGrantVersion:2,scopeIds:['projects:read'],ttlHours:24};
  const keyHeader=headers('machine-first-token');
  assert.equal((await send('GET',root,undefined)).statusCode,401);
  assert.equal((await send('GET',root,undefined,{authorization:'Bearer pk_fake'})).statusCode,401);
  assert.equal((await send('GET',root,undefined,{...owner,authorization:'Bearer anything'})).statusCode,401);
  assert.equal((await send('GET',root,undefined,{cookie:'publikator_session='+createSessionToken()})).statusCode,401,
    'legacy signed owner cookie may not administer tokens');
  assert.equal((await send('POST',root,body,{cookie,'idempotency-key':'missing-origin'})).statusCode,403);
  assert.equal((await send('POST',root,body,{...keyHeader,origin:'https://malicious.example'})).statusCode,403);
  assert.equal((await send('POST',root,body,owner)).statusCode,400);
  assert.equal((await send('POST',root,body,{...keyHeader,authorization:'Bearer anything'})).statusCode,401);
  assert.equal((await send('POST',root,{...body,ttlHours:721},headers('invalid-ttl'))).statusCode,400);
  assert.equal((await send('POST',root,{...body,scopeIds:['publish:request']},headers('no-publish'))).statusCode,403);
  assert.equal((await send('POST',root,{...body,scopeIds:['projects:read','projects:read']},headers('duplicates'))).statusCode,400);
  assert.equal((await send('POST',root,{...body,expectedGrantVersion:1},headers('stale'))).statusCode,409);
  assert.equal((await send('POST',root,{...body,secret:'malicious'},headers('extra-field'))).statusCode,400);
  assert.equal((await send('POST','/api/owner/agents/'+chatgpt.agentId+'/machine-keys',
    body,headers('not-chatgpt-machine'))).statusCode,403,
    'ChatGPT must use OAuth, not unattended machine keys');
  assert.equal((await send('POST','/api/owner/agents/'+helper.agentId+'/machine-keys',
    {...body,scopeIds:['posts:read']},headers('not-helpers-scope'))).statusCode,403);

  const first=await Promise.all([
    send('POST',root,body,keyHeader),send('POST',root,
      {ttlHours:24,scopeIds:['projects:read'],expectedGrantVersion:2},keyHeader)
  ]);
  assert.deepEqual(first.map(r=>r.statusCode).sort(),[200,201]);
  const issued=first.find(r=>r.statusCode===201).json();
  const replay=first.find(r=>r.statusCode===200).json();
  assert.match(issued.bearerToken,/^pak1_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.secretAvailable,true);
  assert.equal(replay.bearerToken,null);
  assert.equal(replay.secretAvailable,false);
  assert.deepEqual(issued.machineKey,replay.machineKey);
  assert.equal(count('agent_machine_keys'),1,'concurrent replay cannot create a second token');
  assert.equal(issued.machineKey.tokenVersion,2);
  assert.equal(issued.machineKey.grantVersion,2);
  assert.deepEqual(issued.machineKey.scopeIds,['projects:read']);
  const userToken=issued.bearerToken;
  assert.equal(authenticateAgentMachineKey(userToken).agentId,n8n.agentId);
  assert.deepEqual(authorizeAgentMachineOperation(userToken,{
    requiredScope:'projects:read',projectId:prj
  }),{agentId:n8n.agentId,tokenVersion:2,grantVersion:2});
  denied(()=>authorizeAgentMachineOperation(userToken,{
    requiredScope:'projects:read',projectId:secondProject
  }),'RESOURCE_DENIED');
  denied(()=>authorizeAgentMachineOperation(userToken,{
    requiredScope:'projects:read'
  }),'RESOURCE_DENIED');
  denied(()=>authorizeAgentMachineOperation(userToken,{
    requiredScope:'posts:read',projectId:prj
  }),'RESOURCE_DENIED');
  denied(()=>authenticateAgentMachineKey(session));
  denied(()=>authenticateAgentMachineKey(process.env.APP_MASTER_KEY));
  denied(()=>authenticateAgentMachineKey('pk_'+'x'.repeat(50)));
  denied(()=>authenticateAgentMachineKey('pak1_'+'A'.repeat(43)));
  assert.equal((await send('GET','/api/owner/agents',undefined,{
    authorization:'Bearer '+userToken
  })).statusCode,401,'machine bearer cannot become owner');
  assert.equal((await send('GET','/api/integration/v1/drafts',undefined,{
    authorization:'Bearer '+userToken
  })).statusCode,401,'machine bearer cannot become legacy Integration API');
  const capabilityBoundary = await send('GET','/api/agent/v1/capabilities',undefined,{
    authorization:'Bearer '+userToken
  });
  assert.equal(capabilityBoundary.statusCode,200,capabilityBoundary.body);
  assert.equal(capabilityBoundary.json().agentId,n8n.agentId);
  assert.deepEqual(capabilityBoundary.json().scopeIds,['projects:read']);
  assert.ok(capabilityBoundary.json().blockedReasons.includes('ONLY_PROJECT_ACCOUNT_AND_SOURCE_LIST_READ_ENABLED'),
    'an authenticated capabilities read must not imply agent resource routes are active');
  const list=await send('GET',root,undefined,{cookie});
  assert.equal(list.statusCode,200,list.body);
  assert.equal(list.json().items.length,1);
  assert.ok(!list.body.includes(userToken),'list only returns safe metadata');
  assert.ok(!list.body.includes('token_hash'));

  const revokeUrl=root+'/'+issued.machineKey.keyId+'/revoke';
  const rotateUrl=root+'/'+issued.machineKey.keyId+'/rotate';
  assert.equal((await send('POST',rotateUrl,{
    expectedGrantVersion:2,ttlHours:24,confirm:false
  },headers('rotate-requires-confirm'))).statusCode,400);
  assert.equal((await send('POST',rotateUrl,{
    expectedGrantVersion:1,ttlHours:24,confirm:true
  },headers('rotate-stale'))).statusCode,409);
  const rotateBody={expectedGrantVersion:2,ttlHours:12,confirm:true};
  const rotated=await send('POST',rotateUrl,rotateBody,headers('rotate-once'));
  assert.equal(rotated.statusCode,201,rotated.body);
  const next=rotated.json();
  assert.notEqual(next.bearerToken,userToken);
  assert.equal(next.secretAvailable,true);
  denied(()=>authenticateAgentMachineKey(userToken));
  assert.equal(authenticateAgentMachineKey(next.bearerToken).agentId,n8n.agentId);
  const rotateReplay=await send('POST',rotateUrl,
    {confirm:true,ttlHours:12,expectedGrantVersion:2},headers('rotate-once'));
  assert.equal(rotateReplay.statusCode,200,rotateReplay.body);
  assert.equal(rotateReplay.json().bearerToken,null);
  assert.deepEqual(rotateReplay.json().machineKey,next.machineKey);
  assert.equal(count('agent_machine_keys'),2);
  assert.equal((await send('POST',revokeUrl,{confirm:true},headers('old-revoked'))).statusCode,409);
  const newRevoke=root+'/'+next.machineKey.keyId+'/revoke';
  const revoked=await send('POST',newRevoke,{confirm:true},headers('revoke-rotated'));
  assert.equal(revoked.statusCode,200,revoked.body);
  assert.ok(revoked.json().revokedAt);
  denied(()=>authenticateAgentMachineKey(next.bearerToken));
  const repeatRevoked=await send('POST',newRevoke,{confirm:true},headers('revoke-rotated'));
  assert.equal(repeatRevoked.statusCode,200);
  assert.deepEqual(repeatRevoked.json(),revoked.json());

  const third=await send('POST',root,body,headers('machine-third'));
  assert.equal(third.statusCode,201,third.body);
  const thirdToken=third.json().bearerToken;
  assert.equal(authenticateAgentMachineKey(thirdToken).agentId,n8n.agentId);
  // An owner privilege edit increments token and grant versions, rendering
  // every previously issued token stale without a special revocation scan.
  const changed=updateOwnerAgentGrant(n8n.agentId,{
    expectedGrantVersion:2,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:['projects:read'],projectIds:[prj],accountIds:[],sourceConnectorIds:[],
    confirmElevation:false
  },'remove-posts-grant');
  assert.equal(changed.grantVersion,3);
  denied(()=>authenticateAgentMachineKey(thirdToken));
  assert.equal((await send('POST',root,body,headers('cannot-issue-stale'))).statusCode,409);

  const helperRoot='/api/owner/agents/'+helper.agentId+'/machine-keys';
  const helperIssued=await send('POST',helperRoot,{
    expectedGrantVersion:2,scopeIds:['projects:read'],ttlHours:1
  },headers('helper-token'));
  assert.equal(helperIssued.statusCode,201,helperIssued.body);
  const helperToken=helperIssued.json().bearerToken;
  denied(()=>authorizeAgentMachineOperation(helperToken,{
    requiredScope:'projects:read',projectId:prj
  }),'RESOURCE_DENIED');
  assert.equal(authenticateAgentMachineKey(helperToken).agentId,helper.agentId);
  db.prepare('UPDATE agent_machine_keys SET expires_at=? WHERE id=?')
    .run('2000-01-01T00:00:00.000Z',helperIssued.json().machineKey.keyId);
  denied(()=>authenticateAgentMachineKey(helperToken));
  const otherToken=await send('POST',helperRoot,{
    expectedGrantVersion:2,scopeIds:['projects:read'],ttlHours:2
  },headers('helper-again'));
  assert.equal(otherToken.statusCode,201,otherToken.body);
  assert.equal(controlOwnerAgent(helper.agentId,'pause',{
    expectedGrantVersion:2,confirm:true
  },'helper-pause').status,'PAUSED');
  denied(()=>authenticateAgentMachineKey(otherToken.json().bearerToken));

  const stored=[
    ...db.prepare('SELECT * FROM agent_machine_keys').all(),
    ...db.prepare('SELECT * FROM agent_activity_events').all(),
    ...db.prepare('SELECT * FROM agent_owner_operation_receipts').all()
  ];
  const serialized=JSON.stringify(stored);
  for(const secret of [userToken,next.bearerToken,thirdToken,helperToken,
    otherToken.json().bearerToken,process.env.APP_MASTER_KEY,session]){
    assert.ok(!serialized.includes(secret),'no credentials may persist in SQLite');
  }
  assert.ok(!serialized.includes('machine-first-token'),'raw idempotency key must not persist');
  const eventCount=count('agent_activity_events');
  await app.close();
  app=await buildApp();
  const afterRestart=await send('POST',root,body,keyHeader);
  assert.equal(afterRestart.statusCode,200,afterRestart.body);
  assert.equal(afterRestart.json().bearerToken,null);
  assert.deepEqual(afterRestart.json().machineKey,issued.machineKey);
  assert.equal(count('agent_activity_events'),eventCount);
  assert.ok(Number(db.pragma('user_version',{simple:true}))>=17);

  // Codex P2 regression: more than 100 newer revoked key records cannot
  // make a still-live older key undiscoverable to its owner.
  const many=createOwnerAgent({name:'Historic key churn agent',clientKind:'n8n'},
    'owner-create-history');
  updateOwnerAgentGrant(many.agentId,{
    expectedGrantVersion:1,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:['projects:read'],projectIds:[prj],accountIds:[],sourceConnectorIds:[],
    confirmElevation:true
  },'owner-grant-history');
  const historyPath='/api/owner/agents/'+many.agentId+'/machine-keys';
  const validIssued=await send('POST',historyPath,{
    expectedGrantVersion:2,scopeIds:['projects:read'],ttlHours:24
  },headers('issue-original-live'));
  assert.equal(validIssued.statusCode,201,validIssued.body);
  const keeper=validIssued.json();
  assert.equal(authenticateAgentMachineKey(keeper.bearerToken).agentId,many.agentId);
  const historical=db.prepare([
    'INSERT INTO agent_machine_keys',
    '(id,agent_id,token_hash,prefix,scope_ids_json,token_version,grant_version,',
    'expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ].join(' '));
  const newFuture=new Date(Date.now()+7200000).toISOString();
  const revokedAt=new Date().toISOString();
  db.transaction(()=>{
    for(let i=1;i<=130;i++){
      historical.run(id('amk'),many.agentId,i.toString(16).padStart(64,'0'),
        'pak1_old'+String(i).padStart(4,'0'),'["projects:read"]',2,2,
        newFuture,revokedAt,new Date(Date.now()+i*60000).toISOString());
    }
  }).immediate();
  const visible=await send('GET',historyPath,undefined,{cookie});
  assert.equal(visible.statusCode,200,visible.body);
  assert.equal(visible.json().items.length,100);
  assert.equal(visible.json().items[0].keyId,keeper.machineKey.keyId,
    'all live keys must sort ahead of the churn history');
  assert.ok(visible.json().items.some(x=>x.keyId===keeper.machineKey.keyId));
  assert.ok(!visible.body.includes(keeper.bearerToken));
  const stop=await send('POST',historyPath+'/'+keeper.machineKey.keyId+'/revoke',
    {confirm:true},headers('revoke-after-history'));
  assert.equal(stop.statusCode,200,stop.body);
  denied(()=>authenticateAgentMachineKey(keeper.bearerToken));

  // When owner changes grants, all 20 old bearer versions become unusable.
  // Those obsolete, unrevoked records must NOT exhaust the new version's cap.
  const currentTokens=[];
  for(let i=0;i<20;i++){
    const rr=await send('POST',historyPath,{
      expectedGrantVersion:2,scopeIds:['projects:read'],ttlHours:24
    },headers('active-cap-'+i));
    assert.equal(rr.statusCode,201,rr.body);
    currentTokens.push(rr.json().bearerToken);
  }
  assert.equal((await send('POST',historyPath,{
    expectedGrantVersion:2,scopeIds:['projects:read'],ttlHours:24
  },headers('active-cap-overflow'))).statusCode,429);
  const changedGrant=updateOwnerAgentGrant(many.agentId,{
    expectedGrantVersion:2,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:['projects:read','posts:read'],projectIds:[prj],accountIds:[],
    sourceConnectorIds:[],confirmElevation:true
  },'change-version-after-cap');
  assert.equal(changedGrant.grantVersion,3);
  denied(()=>authenticateAgentMachineKey(currentTokens[0]));
  const replacement=await send('POST',historyPath,{
    expectedGrantVersion:3,scopeIds:['projects:read'],ttlHours:24
  },headers('new-version-after-cap'));
  assert.equal(replacement.statusCode,201,replacement.body);
  assert.equal(authenticateAgentMachineKey(replacement.json().bearerToken).agentId,many.agentId);
  const replacementList=await send('GET',historyPath,undefined,{cookie});
  assert.equal(replacementList.statusCode,200,replacementList.body);
  assert.equal(replacementList.json().items[0].keyId,replacement.json().machineKey.keyId);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM agent_machine_keys WHERE agent_id=?')
    .all(many.agentId)).includes(replacement.json().bearerToken));

  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A1b2b1',schema:Number(db.pragma('user_version',{simple:true})),
    ownerOnly:true,oauthClientsExcluded:true,oneTimeSecret:true,
    exactIdempotency:true,atomicRotation:true,immediateRevoke:true,
    staleGrantAndTokenDenied:true,expiryDenied:true,pausedDenied:true,
    crossAgentACL:true,legacyIsolation:true,noExternalRoute:true,
    noSecretsPersisted:true,restartSafe:true,activeKeysAlwaysDiscoverable:true,staleKeyQuotaSafe:true}));
}finally{
  await app.close();
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
