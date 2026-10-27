import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-agent-a2b3-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=root;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY='a2b3-test-owner-encryption-master-key-2026';
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
  'owner','agent-a2b3-owner-password-2026','agent-a2b3-owner-password-2026');
const listUrl='/api/agent/v1/posts',authorization=token=>({
  authorization:'Bearer '+token
});
const read=(url,head={})=>app.inject({method:'GET',url,headers:head});
const mutate=(method,url,data,head)=>app.inject({
  method,url,payload:data,headers:head
});
const count=table=>db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;

try {
  assert.equal(Number(db.pragma('user_version',{simple:true})),18);
  const project=db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  const otherProject=id('prj'),originalTime=nowIso();
  db.prepare('INSERT INTO projects(id,name,slug,created_at) VALUES (?,?,?,?)')
    .run(otherProject,'Other owner project','a2b3-other-project',originalTime);
  const a1=id('acc'),a2=id('acc'),outside=id('acc');
  for(const [accountId,platform] of [
    [a1,'telegram'],[a2,'vk'],[outside,'max']
  ]){
    db.prepare('INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)')
      .run(accountId,platform,'Synthetic '+accountId,
        encryptJson({token:'a2b3-never-disclose-provider-credential'}),originalTime,originalTime);
  }
  const agent=createOwnerAgent({name:'Own-draft reader',clientKind:'n8n'},'a2b3-owner-main');
  const foreign=createOwnerAgent({name:'Other machine agent',clientKind:'rest_client'},'a2b3-owner-foreign');
  const shadow=createOwnerAgent({name:'Same resource, foreign owner',clientKind:'n8n'},'a2b3-owner-shadow');
  const empty=createOwnerAgent({name:'No account access',clientKind:'n8n'},'a2b3-owner-empty');
  function grant(bot,scopes,prjs,accounts,idem) {
    const v=updateOwnerAgentGrant(bot.agentId,{
      expectedGrantVersion:1,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
      scopeIds:scopes,projectIds:prjs,accountIds:accounts,
      sourceConnectorIds:[],confirmElevation:true
    },idem);
    assert.equal(v.grantVersion,2);
  }
  grant(agent,['posts:read','posts:write'],[project],[a1,a2],'a2b3-grant-one');
  grant(foreign,['posts:read','posts:write'],[otherProject],[outside],'a2b3-grant-other');
  grant(shadow,['posts:read'],[project],[a1,a2],'a2b3-grant-shadow');
  grant(empty,['posts:read'],[project],[],'a2b3-grant-empty');
  function key(bot,scope,k,version=2) {
    const x=issueOwnerMachineKey(bot.agentId,{
      expectedGrantVersion:version,scopeIds:[scope],ttlHours:24
    },k);
    assert.match(x.bearerToken,/^pak1_[A-Za-z0-9_-]{43}$/);
    return x.bearerToken;
  }
  const writer=key(agent,'posts:write','a2b3-key-write');
  const reader=key(agent,'posts:read','a2b3-key-read');
  const otherWriter=key(foreign,'posts:write','a2b3-key-foreign-write');
  const otherReader=key(foreign,'posts:read','a2b3-key-foreign-read');
  const shadowRead=key(shadow,'posts:read','a2b3-key-shadow-read');
  const emptyRead=key(empty,'posts:read','a2b3-key-empty-read');
  async function draft(prj,targets,title,body,token,idem) {
    const r=await mutate('POST',listUrl,{
      projectId:prj,contentFormat:'TEXT_ONLY',publicationKind:'FEED',
      internalTitle:title,bodyPlain:body,targetAccountIds:targets,
      mediaAssetIds:[],schedule:null
    },{...authorization(token),'idempotency-key':idem});
    assert.equal(r.statusCode,201,r.body);
    return r.json().postId;
  }
  const p1=await draft(project,[a1],'First title','First draft text',writer,'a2b3-new-1');
  const p2=await draft(project,[a2,a1],'Second title','Second draft text',writer,'a2b3-new-2');
  const p3=await draft(project,[a2],'Third title','Third draft text',writer,'a2b3-new-3');
  const foreignId=await draft(otherProject,[outside],'Foreign title',
    'Foreign private draft',otherWriter,'a2b3-new-foreign');
  const manual=id('post'),orphan=id('post');
  db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'Manual draft','Manual private contents','DRAFT','DRAFT','MANUAL','manual',?,?)")
    .run(manual,project,originalTime,originalTime);
  db.prepare("INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,source_type,created_at,updated_at) VALUES (?,?,'Unowned agent draft','Orphan text','DRAFT','DRAFT','MANUAL','agent-api',?,?)")
    .run(orphan,project,originalTime,originalTime);
  const expected=[p1,p2,p3].sort();
  const before={posts:count('posts'),events:count('agent_activity_events'),
    receipts:count('agent_operation_receipts')};
  const protectedTables=[
    'posts','post_targets','content_revisions','agent_draft_ownership',
    'agent_operation_receipts','agent_activity_events','agent_grants',
    'agent_principals','agent_machine_keys','publication_units',
    'media','content_media','social_accounts'
  ];
  const dbSnapshot=()=>Object.fromEntries(protectedTables.map(table=>
    [table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
  const beforeReads=dbSnapshot();

  const response=await read(listUrl,authorization(reader));
  assert.equal(response.statusCode,200,response.body);
  const listed=response.json();
  assert.deepEqual(listed.items.map(x=>x.postId),expected);
  assert.equal(listed.pagination.limit,50);
  assert.equal(listed.pagination.nextCursor,null);
  assert.equal(response.headers['cache-control'],'no-store');
  assert.deepEqual(listed.items.map(x=>x.bodyPlain).sort(),
    ['First draft text','Second draft text','Third draft text'].sort());
  for(const post of listed.items) {
    assert.deepEqual(Object.keys(post).sort(),[
      'postId','projectId','contentVersion','status','editorialStage',
      'contentFormat','publicationKind','internalTitle','bodyPlain',
      'targetAccountIds','mediaAssetIds','targetTextOverrides','schedule'
    ].sort());
    assert.equal(post.projectId,project);
    assert.equal(post.status,'DRAFT');
    assert.equal(post.editorialStage,'DRAFT');
    assert.equal(post.contentFormat,'TEXT_ONLY');
    assert.equal(post.publicationKind,'FEED');
    assert.deepEqual(post.mediaAssetIds,[]);
    assert.deepEqual(post.targetTextOverrides,[]);
    assert.equal(post.schedule,null);
  }
  for(const secret of [foreignId,manual,orphan,
    'Foreign private draft','Manual private contents','Orphan text',
    'a2b3-never-disclose-provider-credential',reader,writer,session]){
    assert.ok(!response.body.includes(secret),'hidden data must not reach agent response');
  }

  const direct=await read(listUrl+'/'+p2,authorization(reader));
  assert.equal(direct.statusCode,200,direct.body);
  assert.deepEqual(direct.json(),listed.items.find(x=>x.postId===p2));
  assert.equal(direct.headers['cache-control'],'no-store');
  const other=await read(listUrl,authorization(otherReader));
  assert.equal(other.statusCode,200,other.body);
  assert.deepEqual(other.json().items.map(x=>x.postId),[foreignId]);
  assert.equal((await read(listUrl+'/'+p1,authorization(otherReader))).statusCode,404);
  assert.equal((await read(listUrl+'/'+foreignId,authorization(reader))).statusCode,404);
  assert.equal((await read(listUrl+'/'+manual,authorization(reader))).statusCode,404);
  assert.equal((await read(listUrl+'/'+orphan,authorization(reader))).statusCode,404);
  assert.deepEqual((await read(listUrl,authorization(shadowRead))).json().items,[]);
  assert.equal((await read(listUrl+'/'+p1,authorization(shadowRead))).statusCode,404);
  assert.deepEqual((await read(listUrl,authorization(emptyRead))).json().items,[]);
  assert.equal((await read(listUrl+'/'+p1,authorization(emptyRead))).statusCode,404);
  assert.equal((await read(listUrl,authorization(writer))).statusCode,403,
    'posts:write does not imply posts:read');
  assert.equal((await read(listUrl+'/'+p1,authorization(writer))).statusCode,403);

  const paged=[];
  let cursor=null;
  for(let i=0;i<expected.length;i++){
    const page=await read(listUrl+'?limit=1'+(cursor?'&cursor='+cursor:''),
      authorization(reader));
    assert.equal(page.statusCode,200,page.body);
    assert.equal(page.json().items.length,1);
    paged.push(page.json().items[0].postId);
    cursor=page.json().pagination.nextCursor;
    if(i<expected.length-1)assert.ok(cursor);
    else assert.equal(cursor,null);
  }
  assert.deepEqual(paged,expected);
  const firstPage=await read(listUrl+'?limit=1',authorization(reader));
  assert.equal(firstPage.statusCode,200);
  const issuedCursor=firstPage.json().pagination.nextCursor;
  assert.ok(typeof issuedCursor==='string' && issuedCursor.includes('.'));
  assert.equal((await read(listUrl+'?limit=100',authorization(reader))).json().items.length,3);
  assert.ok(!issuedCursor.includes('draft text'));
  assert.ok(!issuedCursor.includes('never-disclose'));
  const mutatedCursor=issuedCursor.slice(0,-1)+(issuedCursor.endsWith('A')?'B':'A');
  assert.equal((await read(listUrl+'?cursor='+mutatedCursor,
    authorization(reader))).statusCode,400,'modified signature must fail');
  assert.equal((await read(listUrl+'?cursor='+issuedCursor,
    authorization(otherReader))).statusCode,400,'different agent cannot reuse signed cursor');
  for(const q of [
    '?limit=0','?limit=101','?limit=1.0','?cursor=bad*',
    '?cursor='+Buffer.from("' OR 1=1 --").toString('base64url'),
    '?agentId='+foreign.agentId,'?status=PUBLISHED',
    '?ownerId='+foreign.agentId,'?includeCredentials=true'
  ]){
    assert.equal((await read(listUrl+q,authorization(reader))).statusCode,400,q);
  }
  const forged=await read(listUrl+'?cursor='+
    Buffer.from(foreignId,'utf8').toString('base64url'),authorization(reader));
  assert.equal(forged.statusCode,400,forged.body);
  assert.ok(!forged.body.includes(foreignId));
  assert.equal((await read(listUrl+'/'+p1+'?agentId='+foreign.agentId,
    authorization(reader))).statusCode,400);
  assert.equal((await read(listUrl+'/bad%2A',authorization(reader))).statusCode,400);

  for(const bad of [
    {},{cookie:'publikator_session='+session},
    {authorization:'Bearer '+session},
    {authorization:'Bearer pk_'+'a'.repeat(43)},
    {...authorization(reader),cookie:'publikator_session='+session}
  ]){
    assert.equal((await read(listUrl,bad)).statusCode,401);
  }
  assert.equal((await read(listUrl,{...authorization(reader),
    origin:'https://evil.example'})).statusCode,403);
  assert.equal((await read(listUrl,{...authorization(reader),
    origin:process.env.PUBLIC_BASE_URL})).statusCode,200);
  assert.equal(count('posts'),before.posts);
  assert.equal(count('agent_activity_events'),before.events);
  assert.equal(count('agent_operation_receipts'),before.receipts);
  assert.deepEqual(dbSnapshot(),beforeReads,
    'GET requests must not modify grants, keys, posts, targets, quotas, receipts or audit');

  // A canonical PATCH changes only the latest working draft, never rewrites
  // immutable earlier content revisions. GET returns the new current version.
  const edit=await mutate('PATCH',listUrl+'/'+p1,{
    expectedContentVersion:1,bodyPlain:'Updated current body'
  },{...authorization(writer),'idempotency-key':'a2b3-edit-own'});
  assert.equal(edit.statusCode,200,edit.body);
  const modified=await read(listUrl+'/'+p1,authorization(reader));
  assert.equal(modified.statusCode,200,modified.body);
  assert.equal(modified.json().bodyPlain,'Updated current body');
  assert.equal(modified.json().contentVersion,2);
  assert.equal(db.prepare('SELECT body FROM content_revisions WHERE post_id=? AND content_version=1')
    .get(p1).body,'First draft text');

  // Non-granted or disabled recipients cause the WHOLE post to disappear.
  db.prepare('UPDATE social_accounts SET enabled=0 WHERE id=?').run(a2);
  const disabledList=await read(listUrl,authorization(reader));
  assert.deepEqual(disabledList.json().items.map(x=>x.postId),[p1]);
  assert.equal((await read(listUrl+'/'+p2,authorization(reader))).statusCode,404);
  db.prepare('UPDATE social_accounts SET enabled=1 WHERE id=?').run(a2);
  db.prepare('UPDATE post_targets SET enabled=0 WHERE post_id=?').run(p3);
  const targetOff=await read(listUrl,authorization(reader));
  assert.ok(!targetOff.json().items.some(x=>x.postId===p3));
  assert.equal((await read(listUrl+'/'+p3,authorization(reader))).statusCode,404);
  db.prepare('UPDATE post_targets SET enabled=1 WHERE post_id=?').run(p3);
  db.prepare("UPDATE post_targets SET override_text='not allowed' WHERE post_id=?").run(p3);
  assert.ok(!(await read(listUrl,authorization(reader))).json().items.some(x=>x.postId===p3));
  assert.equal((await read(listUrl+'/'+p3,authorization(reader))).statusCode,404);
  db.prepare('UPDATE post_targets SET override_text=NULL WHERE post_id=?').run(p3);
  assert.deepEqual((await read(listUrl,authorization(reader))).json().items.map(x=>x.postId),expected);

  await app.close();
  app=await buildApp();
  const restart=await read(listUrl+'/'+p1,authorization(reader));
  assert.equal(restart.statusCode,200,restart.body);
  assert.equal(restart.json().bodyPlain,'Updated current body');

  // A new grant revokes old machine keys and removes drafts targeting
  // accounts outside the reduced exact allowlist.
  const changed=updateOwnerAgentGrant(agent.agentId,{
    expectedGrantVersion:2,presetId:'CUSTOM',publishMode:'DRAFT_ONLY',
    scopeIds:['posts:read','posts:write'],projectIds:[project],accountIds:[a1],
    sourceConnectorIds:[],confirmElevation:false
  },'a2b3-narrow-grant');
  assert.equal(changed.grantVersion,3);
  assert.equal((await read(listUrl,authorization(reader))).statusCode,401);
  const newReader=key(agent,'posts:read','a2b3-new-reader',3);
  assert.equal((await read(listUrl+'?cursor='+issuedCursor,
    authorization(newReader))).statusCode,400,'cursor must not survive grant version change');
  assert.deepEqual((await read(listUrl,authorization(newReader))).json().items.map(x=>x.postId),[p1]);
  assert.equal((await read(listUrl+'/'+p2,authorization(newReader))).statusCode,404);
  controlOwnerAgent(foreign.agentId,'pause',
    {expectedGrantVersion:2,confirm:true},'a2b3-pause-foreign');
  assert.equal((await read(listUrl,authorization(otherReader))).statusCode,401);
  db.prepare('UPDATE agent_machine_keys SET expires_at=? WHERE agent_id=?')
    .run('2000-01-01T00:00:00.000Z',shadow.agentId);
  assert.equal((await read(listUrl,authorization(shadowRead))).statusCode,401);
  console.log(JSON.stringify({ok:true,checkpoint:'AGENT-A2b3',schema:18,
    originalAgentOwnership:true,sqlBoundProjectAndTargetAcl:true,
    absentForbiddenPosts404:true,readScopeRequired:true,
    currentDraftAndRevision:true,stablePagination:true,forgedCursorSafe:true,
    signedAgentBoundCursors:true,staleGrantCursorDenied:true,
    immutableGetDatabaseState:true,
    disabledTargetInvisible:true,revokedGrantDenied:true,
    noProviderSecretsOrSideEffects:true,restartSafe:true}));
} finally {
  await app.close();
  db.close();
  await fs.rm(root,{recursive:true,force:true});
}
