import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-real-chat-'));
process.env.NODE_ENV='test';process.env.DATA_DIR=temp;delete process.env.ADMIN_PASSWORD;process.env.APP_MASTER_KEY='real-owner-chat-isolated-fixture-master-20261104';process.env.PUBLIC_BASE_URL='http://127.0.0.1:8080';
const {db,migrate}=await import('../dist/db.js');const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');const {saveAiConnection}=await import('../dist/owner-ai-providers.js');const {buildApp}=await import('../dist/app.js');
migrate();const token=createOrRecoverAdmin('INITIAL',createAdminSetupGrant('INITIAL'),'owner','synthetic-real-chat-acceptance','synthetic-real-chat-acceptance');
const connection=saveAiConnection('owner',{provider:'ollama',name:'Real local model',baseUrl:process.env.OLLAMA_TEST_URL||'http://127.0.0.1:11434',model:process.env.OLLAMA_TEST_MODEL||'gemma4:12b'});
const app=await buildApp();await app.ready();const headers={host:'127.0.0.1:8080',origin:'http://127.0.0.1:8080',cookie:'publikator_session='+token};
async function call(method,url,payload){const r=await app.inject({method,url,headers,...(payload?{payload}:{})});assert.ok(r.statusCode<400,r.body);return r.json();}
async function wait(id){for(let n=0;n<250;n++){const r=await call('GET','/api/assistant/runs/'+id);if(r.status!=='RUNNING')return r;await new Promise(resolve=>setTimeout(resolve,1000));}throw new Error('Real model run exceeded deadline');}
try{
 const thread=await call('POST','/api/assistant/threads',{});const before=db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
 const read=await call('POST','/api/assistant/runs',{threadId:thread.id,connectionId:connection.id,message:'Проверь реальные проекты через инструмент и перечисли их названия. Ничего не изменяй.',allowWrites:false,idempotencyKey:'real-read'});
 const a=await wait(read.id);assert.equal(a.status,'COMPLETED',JSON.stringify(a));assert.ok(a.result.actions.some(x=>x.tool==='publikator_list_projects'||x.tool==='publikator_read_operation'));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,before);
 console.log(JSON.stringify({stage:'real_embedded_read',model:connection.model,status:a.status,tools:a.result.actions.map(x=>x.tool),answer:a.result.text.slice(0,1200)}));
 const create=await call('POST','/api/assistant/runs',{threadId:thread.id,connectionId:connection.id,message:'Создай один черновик только с текстом в первом существующем проекте: заголовок «Проверка локального помощника», текст «Тест завершён». Получателей не выбирай, передай пустой targetAccountIds. Ничего не публикуй и не планируй.',allowWrites:true,idempotencyKey:'real-create'});
 const b=await wait(create.id);assert.equal(b.status,'COMPLETED',JSON.stringify(b));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,before+1);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status!='DRAFT'").get().n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM post_targets WHERE enabled=1').get().n,0);
 console.log(JSON.stringify({stage:'real_embedded_draft',model:connection.model,status:b.status,tools:b.result.actions.map(x=>x.tool),answer:b.result.text.slice(0,1200),realProviderPosts:0,result:'PASS'}));
}finally{await app.close();db.close();await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
