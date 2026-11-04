import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { authenticateOwnerKey, createOwnerAutomationKey, listOwnerAutomationKeys, revokeOwnerAutomationKey, sessionActor, safeOutput, OwnerAutomationError, objectValue, boundedString, type OwnerActor } from '../owner-automation.js';
import { ownerMutationOriginMatches } from './security.js';
import { listAiConnections, saveAiConnection, getAiConnection, listAiModels, discoverAiModels } from '../owner-ai-providers.js';
import { createAiThread, listAiThreads, getAiThread, startAiRun, getAiRun, stopAiRun, testAiConnection, recoverInterruptedAiRuns, stopAllAiRuns } from '../owner-ai-chat.js';
import { stageOwnerUpload, cleanupOwnerUploads } from '../owner-ai-uploads.js';
import type { createOwnerTools } from '../owner-tools.js';

type Registry=ReturnType<typeof createOwnerTools>;
const keyRequests=new Map<string,{at:number,count:number}>();
function fail(reply:FastifyReply,error:unknown):any {
  if(error instanceof OwnerAutomationError)return reply.code(error.status).send({error:{code:error.code,message:error.message}});
  return reply.code(500).send({error:{code:'ASSISTANT_ERROR',message:'Не удалось выполнить действие. Проверьте журнал приложения.'}});
}
function owner(request:FastifyRequest,mutation=false):OwnerActor {
  const actor=sessionActor(request);
  if(mutation&&!ownerMutationOriginMatches(request))throw new OwnerAutomationError('INVALID_ORIGIN','Требуется запрос из интерфейса Publikator.',403);
  return actor;
}
export async function registerOwnerAssistant(app:FastifyInstance,registry:Registry):Promise<void> {
  recoverInterruptedAiRuns();
  db.prepare("UPDATE owner_ai_uploads SET state='BROKEN' WHERE state='WRITING'").run();
  await cleanupOwnerUploads();
  app.addHook('onClose',async()=>{await stopAllAiRuns();});
  app.get('/api/assistant/status',async(req,reply)=>{try{owner(req);return {enabled:true,role:'OWNER_ADMIN',mcpPath:'/mcp',mcpUrl:(config.publicBaseUrl||'http://127.0.0.1:8080')+'/mcp',authentication:'owner-issued bearer key',oauthAvailable:false,tools:registry.tools.map(t=>({name:t.name,description:t.description,readOnly:t.readOnly})),operationCount:registry.operations.size,cloudClientConnectionVerified:false};}catch(e){return fail(reply,e);}});
  app.get('/api/assistant/connections',async(req,reply)=>{try{const a=owner(req);return {connections:listAiConnections(a.ownerId)};}catch(e){return fail(reply,e);}});
  app.post('/api/assistant/discover-models',{bodyLimit:16384},async(req,reply)=>{try{const a=owner(req,true);return await discoverAiModels(a.ownerId,req.body);}catch(e){return fail(reply,e);}});
  app.post('/api/assistant/connections',{bodyLimit:16384},async(req,reply)=>{try{const a=owner(req,true);return saveAiConnection(a.ownerId,req.body);}catch(e){return fail(reply,e);}});
  app.post('/api/assistant/connections/:id/test',async(req,reply)=>{try{const a=owner(req,true);return await testAiConnection(a.ownerId,(req.params as any).id);}catch(e){return fail(reply,e);}});
  app.get('/api/assistant/connections/:id/models',async(req,reply)=>{try{const a=owner(req);return {models:await listAiModels(getAiConnection(a.ownerId,(req.params as any).id))};}catch(e){return fail(reply,e);}});
  app.delete('/api/assistant/connections/:id',async(req,reply)=>{try{const a=owner(req,true);const cid=(req.params as any).id;const running=db.prepare("SELECT id FROM owner_ai_runs WHERE connection_id=? AND owner_id=? AND status='RUNNING'").get(cid,a.ownerId);if(running)throw new OwnerAutomationError('CONNECTION_BUSY','Сначала остановите выполняющийся запрос.',409);const r=db.prepare('DELETE FROM owner_ai_connections WHERE id=? AND owner_id=?').run(cid,a.ownerId);if(!r.changes)throw new OwnerAutomationError('NOT_FOUND','Подключение не найдено.',404);return {ok:true};}catch(e){return fail(reply,e);}});
  app.get('/api/assistant/keys',async(req,reply)=>{try{const a=owner(req);return {keys:listOwnerAutomationKeys(a.ownerId)};}catch(e){return fail(reply,e);}});
  app.post('/api/assistant/keys',{bodyLimit:4096},async(req,reply)=>{try{const a=owner(req,true);return reply.code(201).send(createOwnerAutomationKey(a.ownerId,req.body));}catch(e){return fail(reply,e);}});
  app.post('/api/assistant/keys/:id/revoke',async(req,reply)=>{try{const a=owner(req,true);revokeOwnerAutomationKey(a.ownerId,(req.params as any).id);return {ok:true};}catch(e){return fail(reply,e);}});
  app.get('/api/assistant/threads',async(req,reply)=>{try{const a=owner(req);return {threads:listAiThreads(a.ownerId)};}catch(e){return fail(reply,e);}});
  app.post('/api/assistant/threads',async(req,reply)=>{try{const a=owner(req,true);const b=req.body?objectValue(req.body):{};return reply.code(201).send(createAiThread(a.ownerId,typeof b.title==='string'?b.title:'Новый диалог'));}catch(e){return fail(reply,e);}});
  app.get('/api/assistant/threads/:id',async(req,reply)=>{try{const a=owner(req);return getAiThread(a.ownerId,(req.params as any).id);}catch(e){return fail(reply,e);}});
  app.post('/api/assistant/runs',{bodyLimit:32768},async(req,reply)=>{try{const a=owner(req,true);return reply.code(202).send(startAiRun(app,registry,a,req.body));}catch(e){return fail(reply,e);}});
  app.get('/api/assistant/runs/:id',async(req,reply)=>{try{const a=owner(req);return getAiRun(a.ownerId,(req.params as any).id);}catch(e){return fail(reply,e);}});
  app.post('/api/assistant/runs/:id/stop',async(req,reply)=>{try{const a=owner(req,true);return stopAiRun(a.ownerId,(req.params as any).id);}catch(e){return fail(reply,e);}});
  app.post('/api/assistant/uploads',{bodyLimit:520*1024*1024},async(req,reply)=>{try{const a=owner(req,true);await cleanupOwnerUploads();const part=await req.file({limits:{fileSize:512*1024*1024,files:1}});if(!part)throw new OwnerAutomationError('FILE_REQUIRED','Выберите файл.');const result=await stageOwnerUpload(a,part.filename,part.mimetype,part.file);if(part.file.truncated)throw new OwnerAutomationError('UPLOAD_TOO_LARGE','Файл превышает допустимый размер.',413);return reply.code(201).send(result);}catch(e){return fail(reply,e);}});
  app.get('/api/assistant/actions',async(req,reply)=>{try{const a=owner(req);return {events:db.prepare('SELECT id,actor_id,operation,status,receipt_id,created_at FROM owner_automation_events WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(a.ownerId)};}catch(e){return fail(reply,e);}});

  // Protected MCP is independent of the browser-cookie namespace and the legacy DRAFT API.
  app.route({method:['GET','POST','DELETE'],url:'/mcp',bodyLimit:10*1024*1024,handler:async(req,reply)=>{
    reply.header('cache-control','no-store');
    try{
      if(req.headers.cookie)throw new OwnerAutomationError('MIXED_AUTH','MCP принимает отдельный Bearer-ключ, а не cookie браузера.',401);
      const actor=authenticateOwnerKey(req.headers.authorization);
      const base=new URL(config.publicBaseUrl||'http://127.0.0.1:8080');
      const host=req.headers.host?.toLowerCase();
      if(host!==base.host.toLowerCase())throw new OwnerAutomationError('INVALID_HOST','Host не соответствует адресу Publikator.',403);
      if(req.headers.origin!==undefined&&req.headers.origin!==base.origin)throw new OwnerAutomationError('INVALID_ORIGIN','Запрос другого сайта отклонён.',403);
      const tick=Date.now();const count=keyRequests.get(actor.actorId);
      if(!count||tick-count.at>60000)keyRequests.set(actor.actorId,{at:tick,count:1});
      else if(++count.count>240)throw new OwnerAutomationError('RATE_LIMIT','Слишком много запросов MCP.',429);
      if(keyRequests.size>1000)for(const[k,v]of keyRequests)if(tick-v.at>60000)keyRequests.delete(k);
      const handler=createMcpHandler(()=>{
        const server=new McpServer({name:'publikator-owner',version:'0.1.0'});
        for(const tool of registry.tools){
          server.registerTool(tool.name,{description:tool.description,inputSchema:tool.schema as any,annotations:{readOnlyHint:tool.readOnly,destructiveHint:!tool.readOnly,idempotentHint:tool.readOnly,openWorldHint:!tool.readOnly}},async(args:any)=>{
            try{const result=await registry.execute(actor,tool.name,args);const output=typeof result==='object'&&result!==null&&!Array.isArray(result)?result:{result};return {content:[{type:'text' as const,text:JSON.stringify(output)}],structuredContent:output,isError:Boolean(output.isError||output.status>=400)};}
            catch(e){const error={code:e instanceof OwnerAutomationError?e.code:'TOOL_FAILED',message:e instanceof OwnerAutomationError?e.message:'Операция не выполнена. Проверьте параметры и журнал.'};return {content:[{type:'text' as const,text:JSON.stringify({error})}],structuredContent:{error},isError:true};}
          });
        }
        return server;
      },{legacy:'stateless'});
      const headers=new Headers();for(const key of ['content-type','accept','mcp-protocol-version','mcp-method','mcp-session-id','last-event-id']){const v=req.headers[key];if(typeof v==='string')headers.set(key,v);}
      const request=new Request(new URL('/mcp',base),{method:req.method,headers,...(req.method==='POST'?{body:JSON.stringify(req.body)}:{})});
      const response=await handler.fetch(request,{parsedBody:req.body});
      response.headers.forEach((value,key)=>{if(!['content-length','connection','transfer-encoding'].includes(key))reply.header(key,value);});
      reply.code(response.status);
      return reply.send(response.body?Readable.fromWeb(response.body as any):undefined);
    }catch(e){if(e instanceof OwnerAutomationError&&e.status===401)reply.header('www-authenticate','Bearer realm="Publikator Owner MCP"');return fail(reply,e);}
  }});
}
