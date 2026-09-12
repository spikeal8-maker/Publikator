import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CONTENT_PLAN_V3_COLUMNS,CONTENT_PLAN_V3_VERSION,MAX_CONTENT_PLAN_V3_BYTES,
  applyContentPlanV3,createContentPlanV3Template,exportContentPlanV3,parseContentPlanV3,validateContentPlanV3
} from '../content-plan-v3.js';
import { beginExclusiveRuntimeMaintenance } from '../runtime-gate.js';

function sourceId(request:FastifyRequest):string {
  const q=request.query as {sourceId?:string}; const h=request.headers['x-publikator-source-id'];
  const value=typeof q.sourceId==='string'&&q.sourceId.trim()?q.sourceId:(typeof h==='string'?h:'');
  if(!value)throw new Error('Нужен sourceId query или x-publikator-source-id'); return value;
}
async function uploaded(request:FastifyRequest):Promise<{filename:string;buffer:Buffer}>{
  const part=await request.file({limits:{files:1,fileSize:MAX_CONTENT_PLAN_V3_BYTES}});if(!part)throw new Error('Файл не передан');
  const filename=path.basename(part.filename||'content-plan-v3.xlsx');const buffer=await part.toBuffer();if(part.file.truncated)throw new Error('Файл больше 20 МБ');return{filename,buffer};
}

export async function registerContentPlanV3Routes(app:FastifyInstance):Promise<void>{
  app.get('/api/content-plan/v3/schema',async()=>({version:CONTENT_PLAN_V3_VERSION,columns:CONTENT_PLAN_V3_COLUMNS,sourceIdentity:'sourceId + external_id',actions:['UPSERT','ARCHIVE','TRASH_REQUEST'],compatibility:'V1 schema 1 endpoints unchanged',foundationLimits:{publicationKinds:['FEED'],contentFormats:['IMAGE'],media:'reserved for next ingestion/media checkpoint',timezone:'UTC until M0-005'}}));
  app.get('/api/content-plan/v3/template.xlsx',async(_request,reply)=>{const buf=await createContentPlanV3Template();reply.header('content-type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');return reply.send(buf);});
  app.get('/api/content-plan/v3/export.xlsx',async(request,reply)=>{try{const buf=await exportContentPlanV3(sourceId(request));reply.header('content-type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');return reply.send(buf);}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:String(error)});}});
  app.post('/api/content-plan/v3/import/preview',async(request,reply)=>{try{const src=sourceId(request);const file=await uploaded(request);return await validateContentPlanV3(await parseContentPlanV3(file.filename,file.buffer),src);}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:String(error)});}});  app.post('/api/content-plan/v3/import/apply',async(request,reply)=>{
    if(request.headers['x-publikator-content-plan']!=='IMPORT')return reply.code(400).send({error:'Нужно подтверждение IMPORT'});
    const expectedSha=request.headers['x-content-plan-sha256'];if(typeof expectedSha!=='string'||!/^[a-f0-9]{64}$/i.test(expectedSha))return reply.code(400).send({error:'Нужен SHA-256 из preview'});
    let release:(()=>void)|null=null;try{const src=sourceId(request);const file=await uploaded(request);const parsed=await parseContentPlanV3(file.filename,file.buffer);if(parsed.fileSha256!==expectedSha.toLowerCase())return reply.code(409).send({error:'Файл изменился после preview'});
      release=beginExclusiveRuntimeMaintenance('content-plan-v3 import');const validation=await validateContentPlanV3(parsed,src);if(!validation.canApply)return reply.code(409).send({error:'Schema 3 preview содержит ERROR/CONFLICT',validation});
      return{ok:true,fileSha256:parsed.fileSha256,...applyContentPlanV3(validation)};
    }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}finally{release?.();}
  });
}
