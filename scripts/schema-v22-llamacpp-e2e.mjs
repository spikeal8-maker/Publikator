import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-llamacpp-'));
Object.assign(process.env, {
  DATA_DIR: directory, NODE_ENV: 'test', PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
  APP_MASTER_KEY: 'llamacpp-provider-fixture-secret-at-least-32-characters',
});
delete process.env.ADMIN_PASSWORD;
const { db, migrate } = await import('../dist/db.js');
const { createAdminSetupGrant, createOrRecoverAdmin } = await import('../dist/admin-auth.js');
const { discoverAiModels, saveAiConnection, updateAiConnectionAccess } = await import('../dist/owner-ai-providers.js');
const { testAiConnection } = await import('../dist/owner-ai-chat.js');
const calls = [];
const fixture = http.createServer(async (req, res) => {
  res.setHeader('content-type','application/json');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  calls.push({url:req.url,key:req.headers.authorization,body:raw ? JSON.parse(raw) : null});
  if (req.url === '/v1/models') {
    res.end(JSON.stringify({data:[{id:'gguf-fixture'}]}));
  } else if (req.url === '/v1/chat/completions') {
    res.end(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{
      id:'fixture-call',type:'function',function:{
        name:'publikator_connection_probe',arguments:'{"marker":"publikator-ready"}'
      }
    }]}}]}));
  } else res.writeHead(404).end('{}');
});

try {
  migrate();
  const password = 'llamacpp-fixture-owner-password';
  createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'), 'owner', password, password);
  const old = saveAiConnection('owner', {provider:'ollama',name:'Existing Ollama',model:'saved',apiKey:'keep-encrypted'});
  updateAiConnectionAccess('owner',old.id,{accessMode:'READ_ONLY',expectedRevision:1});
  const before = db.prepare('SELECT * FROM owner_ai_connections WHERE id=?').get(old.id);

  // Build the actual pre-v22 provider constraint for the upgrade fixture.
  const createTable = db.prepare("SELECT sql FROM sqlite_schema WHERE name='owner_ai_connections'").get().sql;
  db.transaction(() => {
    db.exec('ALTER TABLE owner_ai_connections RENAME TO current_connections');
    db.exec(createTable.replace(",'llamacpp'",""));
    db.exec('INSERT INTO owner_ai_connections SELECT * FROM current_connections');
    db.exec('DROP TABLE current_connections');
    db.pragma('user_version = 21');
  }).immediate();
  migrate();
  assert.equal(db.pragma('user_version',{simple:true}),22);
  assert.deepEqual(db.prepare('SELECT * FROM owner_ai_connections WHERE id=?').get(old.id),before);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);

  await new Promise(resolve => fixture.listen(0,'127.0.0.1',resolve));
  const baseUrl = 'http://127.0.0.1:'+fixture.address().port;
  const details = await discoverAiModels('owner',{provider:'llamacpp',baseUrl});
  assert.deepEqual(details.models,['gguf-fixture']);
  const next = saveAiConnection('owner',{provider:'llamacpp',name:'Local GGUF',model:details.suggestedModel,baseUrl,apiKey:'optional-fixture-key'});
  assert.equal(next.baseUrl,baseUrl+'/v1');
  assert.equal(next.provider,'llamacpp');
  assert.equal((await testAiConnection('owner',next.id)).toolCalling,true);
  assert.deepEqual(calls.map(c=>c.url),['/v1/models','/v1/chat/completions']);
  assert.equal(calls[0].key,undefined);
  assert.equal(calls[1].key,'Bearer optional-fixture-key');
  assert.equal(calls[1].body.tools[0].function.name,'publikator_connection_probe');
  assert.equal(calls[1].body.model,'gguf-fixture');
  await assert.rejects(discoverAiModels('owner',{provider:'llamacpp',baseUrl:'http://169.254.169.254'}),{code:'ENDPOINT_BLOCKED'});
  await assert.rejects(discoverAiModels('owner',{provider:'llamacpp',baseUrl:'http://203.0.113.1'}),{code:'ENDPOINT_BLOCKED'});
  await assert.rejects(discoverAiModels('owner',{provider:'compatible',baseUrl:'http://127.0.0.1:8080/v1',apiKey:'fixture'}),{code:'INVALID_ENDPOINT'});
  console.log('Schema 22 preserves existing connections and llama.cpp lists models and calls a tool PASS');
} finally {
  if (fixture.listening) {
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  }
  db.close();
  await fs.rm(directory,{recursive:true,force:true,maxRetries:5});
}
