import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { applyContentBundle, previewContentBundle } from '../content-bundle.js';
import { beginExclusiveRuntimeMaintenance } from '../runtime-gate.js';

function sourceId(request:FastifyRequest):string{
  const value=(request.query as {sourceId?:string}).sourceId;
  if(typeof value!=='string'||!value.trim())throw new Error('Нужен sourceId');
  return value.trim();
}

async function uploaded(request:FastifyRequest):Promise<{filename:string;buffer:Buffer}>{
  const part=await request.file({limits:{files:1,fileSize:config.maxBundleUploadBytes}});
  if(!part)throw new Error('ZIP bundle не передан');
  const filename=path.basename(part.filename||'content-bundle.zip');
  if(path.extname(filename).toLowerCase()!=='.zip')throw new Error('Content Bundle должен быть .zip');
  const buffer=await part.toBuffer();
  if(part.file.truncated)throw new Error('Content Bundle превышает compressed-size limit');
  return {filename,buffer};
}

export async function registerContentBundleRoutes(app:FastifyInstance):Promise<void>{
  app.post('/api/content-bundle/v1/preview',async(request,reply)=>{
    try{
      const file=await uploaded(request);
      return await previewContentBundle(file.buffer,sourceId(request));
    }catch(error){
      return reply.code(400).send({error:error instanceof Error?error.message:String(error)});
    }
  });

  app.post('/api/content-bundle/v1/apply',async(request,reply)=>{
    let release:(()=>void)|null=null;
    try{
      if(request.headers['x-publikator-content-bundle']!=='IMPORT')return reply.code(400).send({error:'Нужно подтверждение IMPORT'});
      const expected=request.headers['x-content-bundle-sha256'];
      if(typeof expected!=='string'||!/^[a-f0-9]{64}$/i.test(expected))return reply.code(400).send({error:'Нужен SHA-256 из Content Bundle preview'});
      const file=await uploaded(request);
      release=beginExclusiveRuntimeMaintenance('content-bundle import');
      return {ok:true,...await applyContentBundle(file.buffer,sourceId(request),expected)};
    }catch(error){
      return reply.code(409).send({error:error instanceof Error?error.message:String(error)});
    }finally{
      release?.();
    }
  });
}
