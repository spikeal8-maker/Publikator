import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-agent-a2a2-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = 'machine-account-list-private-master-key-for-tests-2026';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
const { createAdminSetupGrant, createOrRecoverAdmin } = await import('../dist/admin-auth.js');
const { encryptJson } = await import('../dist/crypto.js');
const { createOwnerAgent, controlOwnerAgent } = await import('../dist/agent-owner-registry.js');
const { updateOwnerAgentGrant } = await import('../dist/agent-owner-grants.js');
const { issueOwnerMachineKey } = await import('../dist/agent-machine-keys.js');
const { saveCapabilityProfile, readCapabilityProfile } =
  await import('../dist/social-credential-capability.js');

migrate();
let app = await buildApp();
const ownerSession = createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'),
  'account_reader_owner', 'account-read-owner-password-2026', 'account-read-owner-password-2026');
const endpoint = '/api/agent/v1/accounts';
const auth = key => ({ authorization: 'Bearer ' + key });
async function read(url, headers={}) {
  return app.inject({ method: 'GET', url, headers });
}
function count(table) {
  return db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
}

try {
  const now = nowIso(), a1=id('acc'), a2=id('acc'), a3=id('acc'), foreign=id('acc');
  const keyMark = 'never-publish-the-provider-secret-2026';
  const rows=[
    [a1,'telegram','Authorized verified',1],
    [a2,'vk','Authorized unverified',1],
    [a3,'max','Authorized disabled',0],
    [foreign,'instagram','Secret outside allowlist',1]
  ];
  for (const [accountId, platform, name, enabled] of rows) {
    db.prepare('INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(accountId,platform,name,encryptJson({bearer:keyMark+accountId}),enabled,now,now);
  }
  const syntheticProfile={
    inspectionCompleted:true,
    providerType:'BOT',
    credential:{validity:'CONFIRMED',identity:'Synthetic bot only',
      declaredPermissions:[],permissionsSource:'provider-inspection'},
    destination:{resolutionState:'CONFIRMED',kind:'CHANNEL',
      id:'synthetic-destination',name:'Test channel',ownershipConfirmed:true},
    methods:[],
    publicationEvidence:{
      TEXT:{state:'CONFIRMED',requiredMethods:[]},
      IMAGE:{state:'DENIED',remediationCodes:['NEEDS_MEDIA_PERMISSION']}
    },
    runtimePrerequisites:[],
    adapterCapability:{
      TEXT:true, IMAGE:true, CAROUSEL:false, VIDEO:false, SHORT:false, STORY:false
    }
  };
  saveCapabilityProfile(a1,syntheticProfile);
  saveCapabilityProfile(a3,syntheticProfile);
  assert.equal(readCapabilityProfile(a1).profileCurrent,true);
  assert.equal(readCapabilityProfile(a1).lastCheckStatus,'SUCCESS');

  const first=createOwnerAgent({name:'Account agent 1',clientKind:'n8n'},'a2a2-owner-first');
  const second=createOwnerAgent({name:'Account agent 2',clientKind:'rest_client'},'a2a2-owner-second');
  const absentScope=createOwnerAgent({name:'No account read scope',clientKind:'n8n'},'a2a2-owner-third');
  const empty=createOwnerAgent({name:'No assigned accounts',clientKind:'n8n'},'a2a2-owner-fourth');
  function grant(agentId,scopeIds,accountIds,key){
    const result=updateOwnerAgentGrant(agentId,{
      expectedGrantVersion:1,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
      scopeIds,projectIds:[],accountIds,sourceConnectorIds:[],confirmElevation:true
    },key);
    assert.equal(result.grantVersion,2);
  }
  grant(first.agentId,['accounts:read'],[a1,a2,a3],'a2a2-grant-first');
  grant(second.agentId,['accounts:read'],[foreign],'a2a2-grant-second');
  grant(absentScope.agentId,['posts:read'],[a1],'a2a2-grant-third');
  grant(empty.agentId,['accounts:read'],[],'a2a2-grant-fourth');
  function issue(agentId,scopes,key){
    const result=issueOwnerMachineKey(agentId,{
      expectedGrantVersion:2,scopeIds:scopes,ttlHours:24
    },key);
    assert.match(result.bearerToken,/^pak1_[A-Za-z0-9_-]{43}$/);
    return result.bearerToken;
  }
  const firstToken=issue(first.agentId,['accounts:read'],'a2a2-token-first');
  const secondToken=issue(second.agentId,['accounts:read'],'a2a2-token-second');
  const thirdToken=issue(absentScope.agentId,['posts:read'],'a2a2-token-third');
  const emptyToken=issue(empty.agentId,['accounts:read'],'a2a2-token-empty');
  const auditBefore=count('agent_activity_events');

  const response=await read(endpoint,auth(firstToken));
  assert.equal(response.statusCode,200,response.body);
  const ordered=[a1,a2,a3].sort();
  const entries=response.json().items;
  assert.deepEqual(entries.map(e=>e.id),ordered);
  assert.deepEqual(Object.keys(entries[0]).sort(),
    ['capability','enabled','id','name','platform']);
  for(const entry of entries){
    assert.ok(entry.capability.formats.length===6);
    assert.ok(entry.capability.formats.every(x=>
      ['READY','BLOCKED','UNKNOWN'].includes(x.state)));
  }
  assert.ok(!response.body.includes(foreign));
  assert.ok(!response.body.includes(keyMark));
  assert.ok(!response.body.includes('credentials_encrypted'));
  assert.ok(!response.body.includes('profileFingerprint'));
  assert.ok(!response.body.includes('Synthetic bot only'));
  assert.ok(!response.body.includes(ownerSession));
  assert.ok(!response.body.includes(firstToken));
  const verified=entries.find(x=>x.id===a1);
  assert.equal(verified.capability.verified,true);
  assert.equal(verified.capability.formats.find(x=>x.format==='TEXT_ONLY').state,'READY');
  assert.equal(verified.capability.formats.find(x=>x.format==='IMAGE').state,'BLOCKED');
  assert.equal(verified.capability.formats.find(x=>x.format==='IMAGE').reasonCode,
    'NEEDS_MEDIA_PERMISSION');
  const unchecked=entries.find(x=>x.id===a2);
  assert.equal(unchecked.capability.verified,false);
  assert.ok(unchecked.capability.formats.every(x=>x.state==='UNKNOWN'));
  const disabled=entries.find(x=>x.id===a3);
  assert.equal(disabled.enabled,false);
  assert.ok(disabled.capability.formats.every(x=>
    x.state==='BLOCKED' && x.reasonCode==='ACCOUNT_DISABLED'));
  assert.equal(count('agent_activity_events'),auditBefore,
    'safe reads cannot fabricate actions');

  const secondResult=await read(endpoint,auth(secondToken));
  assert.equal(secondResult.statusCode,200,secondResult.body);
  assert.deepEqual(secondResult.json().items.map(x=>x.id),[foreign]);
  for(const acc of ordered) assert.ok(!secondResult.body.includes(acc));
  assert.equal((await read(endpoint,auth(thirdToken))).statusCode,403);
  const noScope=await read(endpoint,auth(thirdToken));
  assert.equal(noScope.json().error.code,'FORBIDDEN_SCOPE');
  const emptyResult=await read(endpoint,auth(emptyToken));
  assert.equal(emptyResult.statusCode,200,emptyResult.body);
  assert.deepEqual(emptyResult.json().items,[]);

  let cursor=null,seen=[];
  for(let i=0;i<3;i++){
    const result=await read(endpoint+'?limit=1'+(cursor?'&cursor='+cursor:''),auth(firstToken));
    assert.equal(result.statusCode,200,result.body);
    assert.equal(result.json().items.length,1);
    seen.push(result.json().items[0].id);
    cursor=result.json().pagination.nextCursor;
    if(i<2)assert.ok(cursor);
    else assert.equal(cursor,null);
  }
  assert.deepEqual(seen,ordered);
  const forbiddenQueries=[
    '?limit=0','?limit=101','?limit=1.0','?cursor=***',
    '?cursor='+Buffer.from("' OR 1=1 --").toString('base64url'),
    '?extra=true','?limit=2&platform=vk'
  ];
  for(const query of forbiddenQueries){
    const bad=await read(endpoint+query,auth(firstToken));
    assert.equal(bad.statusCode,400,query);
  }
  const foreignCursor=Buffer.from(foreign).toString('base64url');
  const forged=await read(endpoint+'?cursor='+foreignCursor,auth(firstToken));
  assert.equal(forged.statusCode,200,forged.body);
  assert.ok(!forged.body.includes(foreign),'cursor cannot add a foreign account');
  const invalidHeaders=[
    {},{cookie:'publikator_session='+ownerSession},
    {authorization:'Bearer '+ownerSession},
    {authorization:'Bearer pk_'+'x'.repeat(44)},
    {authorization:'Bearer '+firstToken,cookie:'publikator_session='+ownerSession}
  ];
  for(const headers of invalidHeaders){
    assert.equal((await read(endpoint,headers)).statusCode,401);
  }
  assert.equal((await read(endpoint,{...auth(firstToken),origin:'https://evil.example'})).statusCode,403);
  assert.equal((await read(endpoint,{...auth(firstToken),origin:process.env.PUBLIC_BASE_URL})).statusCode,200);
  assert.equal((await read('/api/agent/v1/sources',auth(firstToken))).statusCode,403,
    'account-only key must not read sources when the route exists');
  assert.equal((await read('/api/agent/v1/posts',auth(firstToken))).statusCode,404);

  // Credential mutation invalidates the previous profile; never show READY.
  db.prepare('UPDATE social_accounts SET credential_version=credential_version+1 WHERE id=?')
    .run(a1);
  assert.equal(readCapabilityProfile(a1).profileCurrent,false);
  const stale=await read(endpoint,auth(firstToken));
  assert.equal(stale.statusCode,200);
  const staleEntry=stale.json().items.find(x=>x.id===a1);
  assert.equal(staleEntry.capability.verified,false);
  assert.ok(staleEntry.capability.formats.every(x=>x.state==='UNKNOWN'));
  // A deleted resource is never visible merely because its ID is in a grant.
  db.prepare('DELETE FROM social_accounts WHERE id=?').run(a2);
  const deleted=await read(endpoint,auth(firstToken));
  assert.equal(deleted.statusCode,200);
  assert.ok(!deleted.json().items.some(x=>x.id===a2));

  await app.close();
  app=await buildApp();
  const restarted=await read(endpoint,auth(firstToken));
  assert.equal(restarted.statusCode,200,restarted.body);
  assert.deepEqual(restarted.json(),deleted.json());
  updateOwnerAgentGrant(first.agentId,{
    expectedGrantVersion:2,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:['accounts:read'],projectIds:[],accountIds:[a1],
    sourceConnectorIds:[],confirmElevation:false
  },'a2a2-reduce-grant');
  assert.equal((await read(endpoint,auth(firstToken))).statusCode,401);
  controlOwnerAgent(second.agentId,'pause',
    {expectedGrantVersion:2,confirm:true},'a2a2-pause-second');
  assert.equal((await read(endpoint,auth(secondToken))).statusCode,401);
  db.prepare('UPDATE agent_machine_keys SET expires_at=? WHERE agent_id=?')
    .run('2000-01-01T00:00:00.000Z',empty.agentId);
  assert.equal((await read(endpoint,auth(emptyToken))).statusCode,401);
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A2a2',
    ownerAccountSqlAcl:true,checkedCapabilityOnly:true,staleProfileDeniedReady:true,
    disabledAccountBlocked:true,foreignAccountInvisible:true,
    noSecretLeak:true,pagination:true,crossAgentIsolation:true,
    cookieAndLegacyDenied:true,noWrites:true,restartSafe:true}));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
