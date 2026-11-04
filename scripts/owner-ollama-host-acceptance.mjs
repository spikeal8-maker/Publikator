import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-ollama-host-'));
process.env.NODE_ENV='test';process.env.DATA_DIR=temp;delete process.env.ADMIN_PASSWORD;process.env.APP_MASTER_KEY='host-ollama-acceptance-synthetic-master-key-20261104';process.env.PUBLIC_BASE_URL='http://127.0.0.1:8080';
const {db,migrate}=await import('../dist/db.js');
const {createAdminSetupGrant,createOrRecoverAdmin}=await import('../dist/admin-auth.js');
const {saveAiConnection,getAiConnection,modelCompletion}=await import('../dist/owner-ai-providers.js');
const {testAiConnection}=await import('../dist/owner-ai-chat.js');
migrate();createOrRecoverAdmin('INITIAL',createAdminSetupGrant('INITIAL'),'owner','ollama-host-fixture-password','ollama-host-fixture-password');
try{
  const c=saveAiConnection('owner',{provider:'ollama',name:'Host model acceptance',baseUrl:process.env.OLLAMA_TEST_URL||'http://127.0.0.1:11434',model:process.env.OLLAMA_TEST_MODEL||'gemma4:12b'});
  const started=Date.now();console.log(JSON.stringify({stage:'real_model_probe',provider:'ollama',model:c.model}));
  const probe=await testAiConnection('owner',c.id);console.log(JSON.stringify({...probe,durationMs:Date.now()-started}));assert.equal(probe.toolCalling,true);
  const connection=getAiConnection('owner',c.id);
  const tool={type:'function',function:{name:'publikator_read_test_schedule',description:'Read a synthetic publication schedule. No writes and no real account access.',parameters:{type:'object',properties:{},additionalProperties:false}}};
  const messages=[{role:'system',content:'Ты — помощник Publikator. Чтобы ответить на вопрос о расписании, вызови publikator_read_test_schedule. Не выдумывай данные. После результата сообщи его по-русски.'},{role:'user',content:'Какая тестовая публикация запланирована?'}];
  const first=await modelCompletion(connection,messages,[tool]);assert.ok(first.tool_calls?.some(x=>x.function.name==='publikator_read_test_schedule'),'actual model should request the read tool');messages.push(first);
  for(const call of first.tool_calls||[])messages.push({role:'tool',name:call.function.name,tool_call_id:call.id,content:JSON.stringify({title:'Тестовый урок робототехники',scheduledAt:'2030-01-01T12:00:00+03:00',synthetic:true})});
  const second=await modelCompletion(connection,messages,[tool]);assert.ok(second.content.length>0);console.log(JSON.stringify({stage:'real_model_read_roundtrip',model:c.model,result:'PASS',answer:second.content.slice(0,1200),toolNames:first.tool_calls.map(x=>x.function.name),realSocialRequests:0}));
}finally{db.close();await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
