import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-agent-a2a3-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='agent-source-acceptance-private-master-key-2026';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const { db,migrate,id,nowIso }=await import('../dist/db.js');
const { buildApp }=await import('../dist/app.js');
const { createAdminSetupGrant,createOrRecoverAdmin }=await import('../dist/admin-auth.js');
const { encryptJson }=await import('../dist/crypto.js');
const { createOwnerAgent,controlOwnerAgent }=await import('../dist/agent-owner-registry.js');
const { updateOwnerAgentGrant }=await import('../dist/agent-owner-grants.js');
const { issueOwnerMachineKey }=await import('../dist/agent-machine-keys.js');

migrate();
let app=await buildApp();
const ownerCookie=createOrRecoverAdmin('INITIAL',createAdminSetupGrant('INITIAL'),
  'source_owner','source-owner-password-2026','source-owner-password-2026');
const endpoint='/api/agent/v1/sources';
const bearer=token=>({ authorization:'Bearer '+token });
async function read(url,headers={}){
  return app.inject({method:'GET',url,headers});
}
function count(table){
  return db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
}
try {
  const time=nowIso(),s1=id('src'),s2=id('src'),s3=id('src'),s4=id('src'),foreign=id('src');
  const marker='TOP_PRIVATE_CONNECTOR_SECRET_SHOULD_NOT_RETURN';
  for(const [sid,type,name,enabled] of [
    [s1,'google_drive','Drive folder source',1],
    [s2,'google_sheets','Spreadsheet source',1],
    [s3,'yandex_disk','Yandex folder source',0],
    [s4,'generic_https','Remote HTTPS source',1],
    [foreign,'google_drive','Foreign secret source',1]
  ]){
    const config={
      token:marker,
      rootPath:'/home/private/secret/root',
      sourceRoot:'private-folder',
      apiEndpoint:'https://private.example.test/?token='+marker
    };
    db.prepare('INSERT INTO ingestion_connectors(id,type,name,config_json,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(sid,type,name,JSON.stringify(config),
        encryptJson({accessToken:marker,refreshToken:marker}),
        enabled,time,time);
  }

  const first=createOwnerAgent({name:'Sources machine A',clientKind:'n8n'},'a2a3-owner-a');
  const second=createOwnerAgent({name:'Sources machine B',clientKind:'rest_client'},'a2a3-owner-b');
  const noScope=createOwnerAgent({name:'Sources without read',clientKind:'n8n'},'a2a3-owner-no-scope');
  const noSource=createOwnerAgent({name:'Sources empty grant',clientKind:'n8n'},'a2a3-owner-empty');
  function grant(agentId,scopeIds,sourceIds,key){
    const response=updateOwnerAgentGrant(agentId,{
      expectedGrantVersion:1,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
      scopeIds,projectIds:[],accountIds:[],sourceConnectorIds:sourceIds,
      confirmElevation:true
    },key);
    assert.equal(response.grantVersion,2);
  }
  grant(first.agentId,['sources:read'],[s1,s2,s3,s4],'a2a3-grant-first');
  grant(second.agentId,['sources:read'],[foreign],'a2a3-grant-second');
  grant(noScope.agentId,['posts:read'],[s1],'a2a3-grant-no-scope');
  grant(noSource.agentId,['sources:read'],[],'a2a3-grant-empty');
  function issue(agentId,scopes,key){
    const response=issueOwnerMachineKey(agentId,{
      expectedGrantVersion:2,scopeIds:scopes,ttlHours:24
    },key);
    assert.match(response.bearerToken,/^pak1_[A-Za-z0-9_-]{43}$/);
    return response.bearerToken;
  }
  const firstToken=issue(first.agentId,['sources:read'],'a2a3-first-token');
  const secondToken=issue(second.agentId,['sources:read'],'a2a3-second-token');
  const restricted=issue(noScope.agentId,['posts:read'],'a2a3-restricted-token');
  const empty=issue(noSource.agentId,['sources:read'],'a2a3-empty-token');

  const beforeEvents=count('agent_activity_events');
  const response=await read(endpoint,bearer(firstToken));
  assert.equal(response.statusCode,200,response.body);
  const list=response.json().items;
  const allowed=[s1,s2,s3,s4].sort();
  assert.deepEqual(list.map(x=>x.id),allowed);
  assert.equal(response.json().pagination.limit,50);
  assert.equal(response.json().pagination.nextCursor,null);
  for(const entry of list){
    assert.deepEqual(Object.keys(entry).sort(),['enabled','id','name','type']);
    assert.ok(['google_drive','google_sheets','yandex_disk','generic_https'].includes(entry.type));
  }
  assert.equal(list.find(x=>x.id===s3).enabled,false);
  assert.equal(list.find(x=>x.id===s4).type,'generic_https');
  assert.ok(!response.body.includes(foreign));
  assert.ok(!response.body.includes(marker));
  assert.ok(!response.body.includes('/home/private/secret/root'));
  assert.ok(!response.body.includes('sourceRoot'));
  assert.ok(!response.body.includes('credentials_encrypted'));
  assert.ok(!response.body.includes(firstToken));
  assert.ok(!response.body.includes(ownerCookie));
  assert.equal(count('agent_activity_events'),beforeEvents,'source list has zero write effects');

  const foreignList=await read(endpoint,bearer(secondToken));
  assert.equal(foreignList.statusCode,200,foreignList.body);
  assert.deepEqual(foreignList.json().items.map(x=>x.id),[foreign]);
  for(const sid of allowed)assert.ok(!foreignList.body.includes(sid));
  assert.equal((await read(endpoint,bearer(restricted))).statusCode,403);
  const noScopeResponse=await read(endpoint,bearer(restricted));
  assert.equal(noScopeResponse.json().error.code,'FORBIDDEN_SCOPE');
  const emptyResponse=await read(endpoint,bearer(empty));
  assert.equal(emptyResponse.statusCode,200);
  assert.deepEqual(emptyResponse.json().items,[]);

  const seen=[];
  let cursor=null;
  for(let i=0;i<allowed.length;i++){
    const result=await read(endpoint+'?limit=1'+(cursor?'&cursor='+cursor:''),
      bearer(firstToken));
    assert.equal(result.statusCode,200,result.body);
    assert.equal(result.json().items.length,1);
    seen.push(result.json().items[0].id);
    cursor=result.json().pagination.nextCursor;
    if(i<allowed.length-1)assert.ok(cursor);
    else assert.equal(cursor,null);
  }
  assert.deepEqual(seen,allowed);
  for(const query of [
    '?limit=0','?limit=101','?limit=1.5',
    '?cursor=%%%','?cursor='+Buffer.from("' OR 1=1 --").toString('base64url'),
    '?agentId='+second.agentId,'?sourceRoot=/private',
    '?limit=1&includeCredentials=true'
  ]){
    assert.equal((await read(endpoint+query,bearer(firstToken))).statusCode,400,query);
  }
  const forged=await read(endpoint+'?cursor='+Buffer.from(foreign).toString('base64url'),
    bearer(firstToken));
  assert.equal(forged.statusCode,200,forged.body);
  assert.ok(!forged.body.includes(foreign));
  for(const headers of [
    {},{cookie:'publikator_session='+ownerCookie},
    {authorization:'Bearer '+ownerCookie},
    {authorization:'Bearer pk_'+'x'.repeat(44)},
    {authorization:'Bearer '+firstToken,cookie:'publikator_session='+ownerCookie}
  ]){
    assert.equal((await read(endpoint,headers)).statusCode,401);
  }
  assert.equal((await read(endpoint,{...bearer(firstToken),origin:'https://evil.example'})).statusCode,403);
  assert.equal((await read(endpoint,{...bearer(firstToken),origin:process.env.PUBLIC_BASE_URL})).statusCode,200);
  assert.equal((await read('/api/agent/v1/sources/'+s1+'/files',bearer(firstToken))).statusCode,404,
    'source-file browsing/import is not implemented by metadata access');
  assert.equal((await read('/api/agent/v1/posts',bearer(firstToken))).statusCode,404);

  await app.close();
  app=await buildApp();
  assert.deepEqual((await read(endpoint,bearer(firstToken))).json(),response.json());
  db.prepare('DELETE FROM ingestion_connectors WHERE id=?').run(s2);
  const afterDelete=await read(endpoint,bearer(firstToken));
  assert.equal(afterDelete.statusCode,200);
  assert.ok(!afterDelete.json().items.some(x=>x.id===s2));
  const reduced=updateOwnerAgentGrant(first.agentId,{
    expectedGrantVersion:2,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:['sources:read'],projectIds:[],accountIds:[],
    sourceConnectorIds:[s1],confirmElevation:false
  },'a2a3-narrow-grant');
  assert.equal(reduced.grantVersion,3);
  assert.equal((await read(endpoint,bearer(firstToken))).statusCode,401);
  controlOwnerAgent(second.agentId,'pause',
    {expectedGrantVersion:2,confirm:true},'a2a3-pause');
  assert.equal((await read(endpoint,bearer(secondToken))).statusCode,401);
  db.prepare('UPDATE agent_machine_keys SET expires_at=? WHERE agent_id=?')
    .run('2000-01-01T00:00:00.000Z',noSource.agentId);
  assert.equal((await read(endpoint,bearer(empty))).statusCode,401);
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A2a3',
    exactSqlAllowlist:true,fourSourceTypes:true,noConfigOrCredentialLeak:true,
    crossAgentIsolation:true,disabledSourceIdentified:true,
    validatedPagination:true,expiredPausedStaleDenied:true,
    noFileBrowseOrImport:true,readOnly:true,restartSafe:true}));
}finally {
  await app.close();
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
