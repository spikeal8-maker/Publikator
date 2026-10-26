import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-agent-a1b2a-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = 'a1b2a-acceptance-test-master-key-not-for-agents-2026';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
const { createAdminSetupGrant, createOrRecoverAdmin } = await import('../dist/admin-auth.js');
const { encryptJson } = await import('../dist/crypto.js');
const { assertEffectiveAgentGrant } = await import('../dist/agent-grant-acl.js');
const { AGENT_PRESETS, AGENT_SCOPES, AGENT_PRESET_VERSION, getAgentPresetModes } =
  await import('../dist/agent-grant-policy.js');

migrate();
let app = await buildApp();
const token = createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'),
  'owner', 'owner-a1b2a-password-2026', 'owner-a1b2a-password-2026');
const cookie = 'publikator_session=' + token;
const origin = 'https://publisher.example.test';
const auth = { cookie, origin };
const now = nowIso();

function count(table) {
  return db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}
async function send(method, url, payload, headers={}) {
  return app.inject({
    method, url, headers, ...(payload === undefined ? {} : { payload })
  });
}
function denied(claim) {
  assert.throws(() => assertEffectiveAgentGrant(claim), e =>
    e && e.code === 'RESOURCE_DENIED' && e.status === 403);
}
function withKey(key) {
  return { ...auth, 'idempotency-key': key };
}
function fixture(table, sql, ...args) {
  db.prepare(sql).run(...args);
}

try {
  const presets = JSON.parse(await fs.readFile(
    new URL('../docs/contracts/agent-access-presets.v1.json', import.meta.url), 'utf8'
  ));
  assert.equal(AGENT_PRESET_VERSION, presets.presetVersion);
  assert.deepEqual([...AGENT_SCOPES].sort(), presets.scopes.map(s => s.id).sort());
  for (const preset of presets.presets) {
    assert.deepEqual([...AGENT_PRESETS[preset.id]].sort(), [...preset.scopes].sort(),
      'runtime scopes must exactly equal contract snapshot: ' + preset.id);
    assert.deepEqual([...getAgentPresetModes(preset.id)], preset.allowedPublishModes);
  }

  const project1 = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
  const project2 = id('prj');
  fixture('projects','INSERT INTO projects(id,name,slug,created_at) VALUES (?,?,?,?)',
    project2,'Other project','foreign',now);
  const acc1=id('acc'), acc2=id('acc');
  fixture('social_accounts',
    "INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'telegram',?,?,1,?,?)",
    acc1,'Allowed account',encryptJson({ botToken: 'not-in-agent-response-1' }),now,now);
  fixture('social_accounts',
    "INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'vk',?,?,1,?,?)",
    acc2,'Foreign account',encryptJson({ token: 'not-in-agent-response-2' }),now,now);
  const source1=id('src'),source2=id('src');
  for (const source of [source1,source2]) {
    fixture('ingestion_connectors',
      "INSERT INTO ingestion_connectors(id,type,name,config_json,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'google_drive','Synthetic source','{}',?,1,?,?)",
      source,encryptJson({serviceKey:'private-test'}),now,now);
  }
  const post1=id('post'),post2=id('post');
  fixture('posts',
    "INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at) VALUES (?,?,?,'Fixture','DRAFT','DRAFT','MANUAL',?,?)",
    post1,project1,'Allowed draft',now,now);
  fixture('posts',
    "INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at) VALUES (?,?,?,'Fixture','DRAFT','DRAFT','MANUAL',?,?)",
    post2,project2,'Other draft',now,now);
  const target1=id('target'),target2=id('target'),targetCross=id('target');
  for (const [target,post,account] of [[target1,post1,acc1],[target2,post2,acc2]]) {
    fixture('post_targets',
      "INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (?,?,?,1,'PENDING',0,?)",
      target,post,account,now);
  }
  const media1=id('media'),media2=id('media');
  for (const [media,post] of [[media1,post1],[media2,post2]]) {
    fixture('media',
      'INSERT INTO media(id,post_id,original_name,relative_path,mime_type,size_bytes,sha256,created_at,sort_order) VALUES (?,?,?,?,?,?,?,?,0)',
      media,post,'synthetic.jpg','synthetic/'+media+'.jpg','image/jpeg',8,'e'.repeat(64),now);
  }

  const create = async (name,kind,key) => {
    const response=await send('POST','/api/owner/agents',{name,clientKind:kind},withKey(key));
    assert.equal(response.statusCode,201,response.body);
    return response.json();
  };
  const bot=await create('Draft helper','chatgpt','create-a1b2a-bot');
  const other=await create('Independent helper','n8n','create-a1b2a-other');
  const base='/api/owner/agents/'+bot.agentId;
  const preview=base+'/grant-preview',update=base+'/grant';
  const beforeCount=count('agent_activity_events');
  const scopeList=['posts:read','projects:read','accounts:read','sources:read','media:read'];
  const change = {
    expectedGrantVersion:1,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:scopeList,projectIds:[project1],accountIds:[acc1],
    sourceConnectorIds:[source1]
  };
  const callPreview = (body,headers=withKey('preview-a1b2a')) =>
    send('POST',preview,body,headers);
  const callUpdate = (body,headers=withKey('grant-a1b2a-001')) =>
    send('PUT',update,body,headers);

  assert.equal((await callPreview(change,{})).statusCode,401,'cookie is mandatory');
  assert.equal((await callPreview(change,{ authorization:'Bearer fake','idempotency-key':'x' })).statusCode,401);
  assert.equal((await callPreview(change,{ ...auth, authorization:'Bearer fake','idempotency-key':'x' })).statusCode,401);
  assert.equal((await callPreview(change,{cookie,'idempotency-key':'x'})).statusCode,403);
  assert.equal((await callPreview(change,{...withKey('x'),origin:'https://attacker.example'})).statusCode,403);
  assert.equal((await callPreview(change,auth)).statusCode,400,'idempotency header required');
  assert.equal((await callPreview({...change,presetId:'FULL_CONTENT',scopeIds:['posts:read']})).statusCode,403);
  assert.equal((await callPreview({...change,publishMode:'PREAPPROVED_POLICY'})).statusCode,409);
  assert.equal((await callPreview({...change,projectIds:['*']})).statusCode,400);
  assert.equal((await callPreview({...change,projectIds:[project1,project1]})).statusCode,400);
  assert.equal((await callPreview({...change,scopeIds:['secret:export']})).statusCode,400);
  assert.equal((await callPreview({...change,accountIds:['acc_missing']})).statusCode,404);
  assert.equal((await callPreview({...change,sourceConnectorIds:['src_missing']})).statusCode,404);
  assert.equal((await callPreview({...change,policyExpiresAt:'2099-12-31T23:59:59Z'})).statusCode,409);
  assert.equal((await callPreview({...change,preapprovedPolicy:{approvedPolicyVersion:1}})).statusCode,409);
  assert.equal((await callPreview({...change,expectedGrantVersion:0})).statusCode,400);
  assert.equal((await callPreview({...change,confirmElevation:'true'})).statusCode,400);
  assert.equal((await callPreview({...change,unexpected:'error'})).statusCode,400);
  const seen=await callPreview(change);
  assert.equal(seen.statusCode,200,seen.body);
  assert.equal(seen.json().before.grantVersion,1);
  assert.equal(seen.json().after.grantVersion,2);
  assert.equal(seen.json().elevation,true);
  assert.equal(seen.json().requiresOwnerConfirmation,true);
  assert.equal(count('agent_activity_events'),beforeCount,'preview must have zero side effects');
  assert.equal(count('agent_owner_operation_receipts'),2,'preview must not write receipts');
  assert.equal((await callUpdate(change)).statusCode,403,'owner must explicitly confirm scope/resource escalation');
  assert.equal(bot.grant.grantVersion,1);

  const elevation={...change,confirmElevation:true};
  const applied=await callUpdate(elevation);
  assert.equal(applied.statusCode,200,applied.body);
  const g=applied.json();
  assert.equal(g.grantVersion,2);
  assert.equal(g.presetId,'CUSTOM');
  assert.equal(g.publishMode,'DRAFT_ONLY');
  assert.deepEqual(g.scopeIds,[...scopeList].sort());
  assert.deepEqual(g.projectIds,[project1]);
  assert.deepEqual(g.accountIds,[acc1]);
  assert.deepEqual(g.sourceConnectorIds,[source1]);
  assert.equal(db.prepare('SELECT token_version FROM agent_principals WHERE id=?').get(bot.agentId).token_version,2);
  assert.equal(count('agent_activity_events'),beforeCount+1);
  assert.equal(count('agent_owner_operation_receipts'),3);

  const claim={
    agentId:bot.agentId,tokenVersion:2,grantVersion:2,
    tokenScopes:['posts:read','projects:read','accounts:read','sources:read','media:read'],
    requiredScope:'posts:read'
  };
  assert.deepEqual(assertEffectiveAgentGrant({...claim,postId:post1}),
    {agentId:bot.agentId,tokenVersion:2,grantVersion:2});
  assertEffectiveAgentGrant({...claim,projectId:project1});
  assertEffectiveAgentGrant({...claim,postId:post1,mediaId:media1});
  assertEffectiveAgentGrant({...claim,targetId:target1,postId:post1});
  assertEffectiveAgentGrant({...claim,accountId:acc1});
  assertEffectiveAgentGrant({...claim,sourceConnectorId:source1,requiredScope:'sources:read'});
  denied({...claim,postId:post2});
  denied({...claim,accountId:acc2});
  denied({...claim,sourceConnectorId:source2,requiredScope:'sources:read'});
  denied({...claim,projectId:project2});
  denied({...claim,mediaId:media2});
  denied({...claim,targetId:target2});
  denied({...claim,targetId:target1,accountId:acc2});
  denied({...claim,postId:post1,projectId:project2});
  denied({...claim,tokenVersion:1});
  denied({...claim,grantVersion:1});
  denied({...claim,tokenScopes:[]});
  denied({...claim,requiredScope:'posts:write'});
  denied({...claim,agentId:other.agentId,tokenVersion:1,grantVersion:1});
  denied({...claim,requiredScope:'publish:request',tokenScopes:['publish:request']});

  // Mixed-recipient posts fail closed, even if their project is allowed.
  fixture('post_targets',
    "INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (?,?,?,1,'PENDING',0,?)",
    targetCross,post1,acc2,now);
  denied({...claim,postId:post1});
  denied({...claim,mediaId:media1});
  denied({...claim,targetId:target1});
  db.prepare('DELETE FROM post_targets WHERE id=?').run(targetCross);
  assertEffectiveAgentGrant({...claim,postId:post1});

  assert.equal((await callUpdate({...change,confirmElevation:true,expectedGrantVersion:1},
    withKey('grant-new-key-stale'))).statusCode,409);
  assert.equal((await callUpdate({...elevation,accountIds:[acc1,acc2]},
    withKey('grant-a1b2a-001'))).statusCode,409,
    'same idempotency key + changed payload must fail');
  const grantAfterPreview=await callPreview({...elevation,expectedGrantVersion:2});
  assert.equal(grantAfterPreview.statusCode,200,grantAfterPreview.body);
  assert.equal(grantAfterPreview.json().elevation,false);
  assert.equal(grantAfterPreview.json().after.grantVersion,2);

  // OWNER_APPROVAL is a request/consent mode, not an external publisher.
  const approved={
    expectedGrantVersion:2,presetId:'EXTENDED',publishMode:'OWNER_APPROVAL',
    projectIds:[project1],accountIds:[acc1],sourceConnectorIds:[source1]
  };
  assert.equal((await callUpdate(approved,withKey('grant-approved-002'))).statusCode,403);
  const upgraded=await callUpdate({...approved,confirmElevation:true},
    withKey('grant-approved-002'));
  assert.equal(upgraded.statusCode,200,upgraded.body);
  assert.equal(upgraded.json().grantVersion,3);
  assert.equal(upgraded.json().publishMode,'OWNER_APPROVAL');
  assert.deepEqual(upgraded.json().scopeIds,[...AGENT_PRESETS.EXTENDED].sort());
  assert.equal(db.prepare('SELECT token_version FROM agent_principals WHERE id=?').get(bot.agentId).token_version,3);
  denied({...claim,tokenVersion:2,grantVersion:2});
  denied({...claim,tokenVersion:3,grantVersion:3,requiredScope:'publish:request',tokenScopes:['publish:request']});
  denied({...claim,tokenVersion:3,grantVersion:3,requiredScope:'schedule:write',tokenScopes:['schedule:write']});

  const reduced={
    expectedGrantVersion:3,presetId:'OBSERVER',publishMode:'DRAFT_ONLY',
    projectIds:[project1],accountIds:[],sourceConnectorIds:[],confirmElevation:false
  };
  const downgraded=await callUpdate(reduced,withKey('grant-reduce-003'));
  assert.equal(downgraded.statusCode,200,downgraded.body);
  assert.equal(downgraded.json().grantVersion,4);
  assert.equal(downgraded.json().publishMode,'DRAFT_ONLY');
  denied({...claim,tokenVersion:3,grantVersion:3});
  denied({...claim,tokenVersion:4,grantVersion:4,postId:post1});
  assertEffectiveAgentGrant({...claim,tokenVersion:4,grantVersion:4,requiredScope:'projects:read',projectId:project1,
    tokenScopes:['projects:read']});

  // Immutable replay returns original grant rather than later narrower state.
  const replay=await callUpdate({
    ...elevation,scopeIds:[...scopeList].reverse(),
    projectIds:[project1],accountIds:[acc1],sourceConnectorIds:[source1]
  });
  assert.equal(replay.statusCode,200,replay.body);
  assert.deepEqual(replay.json(),g);
  assert.equal(count('agent_activity_events'),beforeCount+3);
  const current=await send('GET',base,undefined,{cookie});
  assert.equal(current.json().grant.grantVersion,4);
  assert.equal(current.json().grant.presetId,'OBSERVER');

  const pause=await send('POST',base+'/pause',{expectedGrantVersion:4,confirm:true},
    withKey('pause-a1b2a-004'));
  assert.equal(pause.statusCode,200,pause.body);
  denied({...claim,tokenVersion:5,grantVersion:5,requiredScope:'projects:read',
    tokenScopes:['projects:read'],projectId:project1});
  const pausedEdit={...reduced,expectedGrantVersion:5};
  const previewWhilePaused=await callPreview(pausedEdit);
  assert.equal(previewWhilePaused.statusCode,200,previewWhilePaused.body);
  assert.equal(previewWhilePaused.json().before.status,'PAUSED');
  const revoke=await send('POST',base+'/revoke',{expectedGrantVersion:5,confirm:true},
    withKey('revoke-a1b2a-005'));
  assert.equal(revoke.statusCode,200,revoke.body);
  assert.equal((await callUpdate({...reduced,expectedGrantVersion:6},
    withKey('post-revoke-update'))).statusCode,409);
  denied({...claim,tokenVersion:6,grantVersion:6,requiredScope:'projects:read',
    tokenScopes:['projects:read'],projectId:project1});

  const receipts=db.prepare('SELECT response_json,request_hash FROM agent_owner_operation_receipts').all();
  const asText=JSON.stringify(receipts);
  assert.ok(!asText.includes(process.env.APP_MASTER_KEY));
  assert.ok(!asText.includes('not-in-agent-response-'));
  assert.ok(!asText.includes('grant-a1b2a-001'));
  const originalEventCount=count('agent_activity_events');

  await app.close();
  app=await buildApp();
  const replayAfterRestart=await callUpdate(elevation);
  assert.equal(replayAfterRestart.statusCode,200,replayAfterRestart.body);
  assert.deepEqual(replayAfterRestart.json(),g);
  assert.equal(count('agent_activity_events'),originalEventCount);
  assert.equal(db.prepare('SELECT grant_version FROM agent_grants WHERE agent_id=?')
    .get(bot.agentId).grant_version,6);

  console.log(JSON.stringify({
    ok:true,checkpoint:'AGENT-A1b2a',
    contractPresets:presets.presets.length,scopes:AGENT_SCOPES.length,
    ownerOnly:true,defaultDeny:true,grantPreviewPure:true,
    confirmsEscalation:true,versionedACL:true,postMediaTargetIsolation:true,
    staleTokenRejected:true,revocationRejected:true,
    autoPublishDisabled:true,immutableReplay:true,restartSafe:true
  }));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
