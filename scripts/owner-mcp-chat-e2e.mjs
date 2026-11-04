import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-owner-mcp-'));
const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const origin='http://127.0.0.1:'+port;
process.env.NODE_ENV='test';process.env.DATA_DIR=temp;delete process.env.ADMIN_PASSWORD;process.env.APP_MASTER_KEY='owner-mcp-chat-test-master-key-20261104-very-long';process.env.PUBLIC_BASE_URL=origin;
const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');
const {encryptJson}=await import('../dist/crypto.js');
const {buildApp}=await import('../dist/app.js');
const {safeOutput}=await import('../dist/owner-automation.js');
migrate();
const session=createOrRecoverAdmin('INITIAL',createAdminSetupGrant('INITIAL'),'owner','owner-chat-fixture-2026-safe','owner-chat-fixture-2026-safe');
const headers={host:new URL(origin).host,origin,cookie:'publikator_session='+session};
const projectId=db.prepare('SELECT id FROM projects LIMIT 1').get().id;
const accountIds=[id('acc'),id('acc')];
for(const accountId of accountIds)db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES(?,'telegram',?, ?,1,?,?)").run(accountId,accountId,encryptJson({botToken:'synthetic-bot-secret-not-for-models',chatId:'@fixture'}),nowIso(),nowIso());
db.prepare('INSERT OR IGNORE INTO project_default_targets(project_id,account_id,created_at) VALUES(?,?,?)').run(projectId,accountIds[0],nowIso());
let outbound=0;
const fake=http.createServer(async(req,res)=>{
  if(req.url==='/api/tags'){res.setHeader('content-type','application/json');res.end(JSON.stringify({models:[{name:'test-tool-model'}]}));return;}
  if(req.url!=='/api/chat'){res.writeHead(404).end();return;}
  outbound++;let input='';for await(const chunk of req)input+=chunk;const body=JSON.parse(input);
  let message;
  if(body.tools?.some(t=>t.function.name==='publikator_connection_probe'))message={role:'assistant',content:'',tool_calls:[{function:{name:'publikator_connection_probe',arguments:{marker:'publikator-ready'}}}]};
  else if(body.messages.at(-1)?.role==='tool')message={role:'assistant',content:'Проверка завершена. Результат указан в журнале.'};
  else {
    const user=body.messages.filter(m=>m.role==='user').at(-1)?.content||'';
    if(user==='SLOW'){await new Promise(r=>setTimeout(r,1800));message={role:'assistant',content:'Slow result'};}
    else if(user==='CREATE'||user==='DENY')message={role:'assistant',content:'',tool_calls:[{function:{name:'publikator_create_post',arguments:{projectId,title:'Chat-created fixture',body:'Synthetic body',contentFormat:'TEXT_ONLY',targetAccountIds:[]}}}]};
    else message={role:'assistant',content:'',tool_calls:[{function:{name:'publikator_list_projects',arguments:{}}}]};
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify({message,done:true}));
});
await new Promise(r=>fake.listen(0,'127.0.0.1',r));const fakeUrl='http://127.0.0.1:'+fake.address().port;
const app=await buildApp();await app.listen({host:'127.0.0.1',port});
const client=new Client({name:'publikator-real-sdk-test',version:'1.0.0'});
let passed=0;
function check(name){passed++;console.log('PASS '+name);}
async function browser(method,url,body,overrides={}){return app.inject({method,url,headers:{...headers,...overrides},...(body===undefined?{}:{payload:body})});}
async function call(name,args){const r=await client.callTool({name,arguments:args});return r.structuredContent||JSON.parse(r.content[0].text);}
async function waitRun(runId){for(let i=0;i<160;i++){const r=(await browser('GET','/api/assistant/runs/'+runId)).json();if(r.status!=='RUNNING')return r;await new Promise(r=>setTimeout(r,50));}throw new Error('Run timeout');}
try{
  assert.equal((await app.inject('/api/assistant/status')).statusCode,401);check('assistant rejects anonymous access');
  assert.equal((await browser('POST','/api/assistant/keys',{name:'bad',confirmOwnerAdmin:true},{origin:'https://attacker.invalid'})).statusCode,403);check('foreign Origin cannot issue keys');
  assert.equal((await browser('POST','/api/assistant/keys',{name:'bad',confirmOwnerAdmin:false})).statusCode,400);check('explicit owner-admin confirmation required');
  const created=(await browser('POST','/api/assistant/keys',{name:'SDK test',confirmOwnerAdmin:true,days:1})).json();assert.match(created.token,/^pom1_/);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM owner_automation_keys').all()).includes(created.token));check('MCP key stored as digest, not plaintext');
  assert.ok(!(await browser('GET','/api/assistant/keys')).body.includes(created.token));check('key list never repeats secret');
  const forged=await app.inject({method:'GET',url:'/api/projects',headers:{host:new URL(origin).host,'x-publikator-owner-delegation':'invented'}});assert.equal(forged.statusCode,401);check('spoofed internal delegation header rejected');
  for(const auth of ['Bearer pk_'+crypto.randomBytes(32).toString('base64url'),'Bearer pak1_'+crypto.randomBytes(32).toString('base64url')])assert.equal((await app.inject({method:'POST',url:'/mcp',headers:{host:new URL(origin).host,authorization:auth},payload:{jsonrpc:'2.0',id:1,method:'tools/list'}})).statusCode,401);check('limited legacy and agent keys do not become administrators');
  assert.equal((await app.inject({method:'GET',url:'/mcp',headers:{host:new URL(origin).host}})).statusCode,401);check('/mcp is protected transport, not HTML');
  assert.equal((await app.inject({method:'POST',url:'/mcp',headers:{host:new URL(origin).host,authorization:'Bearer '+created.token,origin:'https://foreign.invalid'},payload:{jsonrpc:'2.0',id:1,method:'tools/list'}})).statusCode,403);check('MCP rejects foreign Origin');
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+created.token}}}));
  const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='publikator_publish_now'));assert.ok(tools.tools.some(t=>t.name==='publikator_call_operation'));assert.ok(tools.tools.length>=18);check('actual official SDK client discovers protected MCP tools');
  const projects=await call('publikator_list_projects',{});assert.equal(projects.status,200);assert.ok(projects.data.some(p=>p.id===projectId));check('SDK tools/call executes canonical read');
  const read=await call('publikator_read_operation',{operation:'get_projects'});assert.equal(read.status,200);check('read-only generic operation reaches canonical GET');
  const deniedWrite=await call('publikator_read_operation',{operation:'post_projects'});assert.equal(deniedWrite.error.code,'READ_OPERATION_REQUIRED');check('read-only generic operation refuses mutations');
  const accounts=await call('publikator_list_accounts',{});assert.equal(accounts.status,200);assert.ok(!JSON.stringify(accounts).includes('synthetic-bot-secret'));check('social credentials not exposed');
  const draftArgs={projectId,title:'Owner MCP fixture',body:'Text',contentFormat:'TEXT_ONLY',targetAccountIds:[],idempotencyKey:'draft-one'};
  const post=await call('publikator_create_post',draftArgs);assert.equal(post.status,201,JSON.stringify(post));const postId=post.data.id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM post_targets WHERE post_id=? AND enabled=1').get(postId).n,0);check('explicit empty targets never inherit project defaults');
  const before=db.prepare('SELECT COUNT(*) AS n FROM post_targets').get().n;
  assert.equal((await call('publikator_get_post',{postId})).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM post_targets').get().n,before);check('MCP read does not create targets');
  const replay=await call('publikator_create_post',draftArgs);assert.equal(replay.data.id,postId);assert.equal(replay.replayed,true);check('write replay returns the same post');
  const conflict=await call('publikator_create_post',{...draftArgs,body:'Changed'});assert.equal(conflict.error.code,'IDEMPOTENCY_CONFLICT');check('idempotency key with different payload rejected');
  const noKey=await call('publikator_call_operation',{operation:'post_projects',body:{name:'No key',slug:'no-key'}});assert.ok(noKey.error);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE slug='no-key'").get().n,0);check('generic write cannot omit durable request identity');
  const badTarget=await call('publikator_set_targets',{postId,expectedContentVersion:1,accountIds:['missing'],idempotencyKey:'bad-target'});assert.equal(badTarget.error.code,'INVALID_TARGETS');check('nonexistent targets fail closed');
  const set=await call('publikator_set_targets',{postId,expectedContentVersion:1,accountIds:[accountIds[1]],idempotencyKey:'select-exact'});assert.equal(set.status,200,JSON.stringify(set));
  const selected=db.prepare('SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1').all(postId);assert.deepEqual(selected.map(x=>x.account_id),[accountIds[1]]);check('selected receiver is exact, not all accounts');
  const changed=await call('publikator_publish_now',{postId,expectedContentVersion:1,targetAccountIds:[accountIds[1]],idempotencyKey:'stale-publish'});assert.equal(changed.error.code,'VERSION_CONFLICT');check('stale content cannot publish');
  const policy=await call('publikator_call_operation',{operation:'post_posts_by_id_ready',path:{id:postId},body:{expectedContentVersion:2},idempotencyKey:'generic-ready-missing-targets'});assert.equal(policy.error.code,'INVALID_TARGETS');check('generic ready cannot bypass exact target guard');
  const unknown=await call('publikator_call_operation',{operation:'post_shell',body:{command:'echo forbidden'},idempotencyKey:'unknown'});assert.equal(unknown.error.code,'UNKNOWN_OPERATION');check('no shell or arbitrary API proxy');
  assert.equal(safeOutput({credentials:{password:'a'},authorization:'Bearer secret',apiKey:'secret'}).apiKey,'[REDACTED]');check('structured secrets are redacted');
  const catalog=await call('publikator_list_operations',{});assert.ok(catalog.operations.length>50);check('installed canonical operation registry is populated');
  const adminAgents=await call('publikator_call_operation',{operation:'get_owner_agents'});assert.equal(adminAgents.status,200,JSON.stringify(adminAgents));check('explicit owner MCP delegation reaches agent administration');
  const bytes=await sharp({create:{width:48,height:32,channels:3,background:{r:60,g:130,b:200}}}).png().toBuffer();
  const expectedHash=crypto.createHash('sha256').update(bytes).digest('hex');
  const begun=await call('publikator_begin_media_upload',{filename:'fixture.png',mimeType:'image/png',sizeBytes:bytes.length,sha256:expectedHash,idempotencyKey:'chunk-begin'});assert.equal(begun.status,201,JSON.stringify(begun));const uploadId=begun.data.uploadId;
  const split=Math.floor(bytes.length/2),first={uploadId,offset:0,dataBase64:bytes.subarray(0,split).toString('base64'),idempotencyKey:'chunk-one'};
  const wrote=await call('publikator_append_media_chunk',first);assert.equal(wrote.status,200,JSON.stringify(wrote));assert.equal(wrote.data.uploadedBytes,split);
  assert.equal((await call('publikator_append_media_chunk',first)).replayed,true);check('chunk retries do not duplicate file bytes');
  const offsetWrong=await call('publikator_append_media_chunk',{...first,idempotencyKey:'chunk-wrong',offset:1});assert.equal(offsetWrong.error.code,'OFFSET_CONFLICT');check('out-of-order media chunks fail closed');
  const second=await call('publikator_append_media_chunk',{uploadId,offset:split,dataBase64:bytes.subarray(split).toString('base64'),idempotencyKey:'chunk-two'});assert.equal(second.status,200,JSON.stringify(second));
  const finalized=await call('publikator_finalize_media_upload',{uploadId,idempotencyKey:'chunk-finish'});assert.equal(finalized.status,200,JSON.stringify(finalized));assert.equal(finalized.data.sha256,expectedHash);check('MCP chunk upload validates complete content SHA');
  const mediaPost=await call('publikator_create_post',{projectId,title:'MCP media fixture',body:'',contentFormat:'MEDIA',targetAccountIds:[],idempotencyKey:'media-post'});assert.equal(mediaPost.status,201,JSON.stringify(mediaPost));
  const linked=await call('publikator_attach_uploaded_media',{postId:mediaPost.data.id,uploadId,expectedContentVersion:1,idempotencyKey:'attach-file'});assert.equal(linked.status,201,JSON.stringify(linked));
  const withMedia=await call('publikator_get_post',{postId:mediaPost.data.id});assert.equal(withMedia.data.media.length,1);assert.equal(withMedia.data.content_version,2);check('MCP attaches canonical image to media-only draft');
  const attachmentReplay=await call('publikator_attach_uploaded_media',{postId:mediaPost.data.id,uploadId,expectedContentVersion:1,idempotencyKey:'attach-file'});assert.equal(attachmentReplay.replayed,true);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media WHERE post_id=?').get(mediaPost.data.id).n,1);check('attachment replay never duplicates canonical media');
  const rowsBefore=db.prepare('SELECT * FROM post_targets ORDER BY id').all();
  const preview=await call('publikator_preview_post',{postId:mediaPost.data.id});assert.equal(preview.status,200,JSON.stringify(preview));assert.deepEqual(db.prepare('SELECT * FROM post_targets ORDER BY id').all(),rowsBefore);check('MCP preview is read-only');
  const cloudBad=await call('publikator_import_cloud_media',{postId:mediaPost.data.id,expectedContentVersion:2,connectorId:'unused',relativePath:'../outside.jpg',idempotencyKey:'cloud-traversal'});assert.equal(cloudBad.error.code,'INVALID_MEDIA_PATH');check('cloud traversal rejected before network access');
  const restoreBad=await call('publikator_restore_backup',{backupName:'fixture.tgz',confirmArchiveName:'other.tgz',confirmReplacesAllData:true,idempotencyKey:'restore-mismatch'});assert.equal(restoreBad.error.code,'CONFIRMATION_REQUIRED');check('database replacement requires exact archive confirmation');
  const small=await call('publikator_upload_small_media',{filename:'small.png',mimeType:'image/png',dataBase64:bytes.toString('base64'),idempotencyKey:'small-file'});assert.equal(small.status,201,JSON.stringify(small));
  const aborted=await call('publikator_abort_media_upload',{uploadId:small.data.id,idempotencyKey:'abort-small'});assert.equal(aborted.status,200,JSON.stringify(aborted));check('unused staged upload can be explicitly removed');
  const connection=(await browser('POST','/api/assistant/connections',{provider:'ollama',name:'Synthetic local model',baseUrl:fakeUrl,model:'test-tool-model',apiKey:'model-key-canary-plain-must-not-leak'})).json();assert.ok(connection.id,JSON.stringify(connection));
  assert.ok(!(await browser('GET','/api/assistant/connections')).body.includes('model-key-canary'));assert.ok(!JSON.stringify(db.prepare('SELECT * FROM owner_ai_connections').all()).includes('model-key-canary'));check('provider key encrypted and write-only');
  const verified=(await browser('POST','/api/assistant/connections/'+connection.id+'/test',{})).json();assert.equal(verified.toolCalling,true,JSON.stringify(verified));check('real HTTP model probe proves tool calling without publication');
  const modelList=(await browser('GET','/api/assistant/connections/'+connection.id+'/models')).json();assert.deepEqual(modelList.models,['test-tool-model']);check('local model discovery works');
  const thread=(await browser('POST','/api/assistant/threads',{})).json();
  const count=db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
  const run=(await browser('POST','/api/assistant/runs',{threadId:thread.id,connectionId:connection.id,message:'CREATE',allowWrites:true,idempotencyKey:'chat-create'})).json();assert.ok(run.id,JSON.stringify(run));
  const finished=await waitRun(run.id);assert.equal(finished.status,'COMPLETED',JSON.stringify(finished));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,count+1);check('embedded chat executes actual draft tool and returns model answer');
  const repeated=(await browser('POST','/api/assistant/runs',{threadId:thread.id,connectionId:connection.id,message:'CREATE',allowWrites:true,idempotencyKey:'chat-create'})).json();assert.equal(repeated.id,run.id);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,count+1);check('chat request retry cannot duplicate actions');
  const deny=(await browser('POST','/api/assistant/runs',{threadId:thread.id,connectionId:connection.id,message:'DENY',allowWrites:false,idempotencyKey:'chat-deny'})).json();await waitRun(deny.id);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,count+1);check('read-only chat rejects hallucinated write tool');
  const slow=(await browser('POST','/api/assistant/runs',{threadId:thread.id,connectionId:connection.id,message:'SLOW',allowWrites:true,idempotencyKey:'chat-cancel'})).json();await browser('POST','/api/assistant/runs/'+slow.id+'/stop',{});assert.equal((await waitRun(slow.id)).status,'CANCELLED');check('chat cancellation is real');
  const rawMessages=JSON.stringify(db.prepare('SELECT * FROM owner_ai_messages').all());assert.ok(!rawMessages.includes('Chat-created fixture'));check('chat history encrypted at rest');
  const endpointBad=await browser('POST','/api/assistant/connections',{provider:'openai',name:'No',baseUrl:'https://attacker.invalid/v1',model:'x',apiKey:'synthetic'});assert.equal(endpointBad.statusCode,400);check('OpenAI key cannot silently move to another host');
  const disabled=await browser('POST','/api/assistant/keys/'+created.id+'/revoke',{});assert.equal(disabled.statusCode,200);
  await assert.rejects(()=>client.listTools());check('revocation blocks the next MCP call');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status IN ('PUBLISHED','PUBLISHING')").get().n,0);check('acceptance sent no real social posts');
  console.log(JSON.stringify({suite:'owner-mcp-chat',passed,tools:tools.tools.length,modelHttpRequests:outbound,result:'PASS'}));
}finally{
  await client.close().catch(()=>{});await app.close();fake.closeAllConnections();await new Promise(r=>fake.close(r));db.close();await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
