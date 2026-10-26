import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, id, nowIso } from '../db.js';
import { AgentRegistryError } from '../agent-registry-error.js';
import { assertEffectiveAgentGrant } from '../agent-grant-acl.js';
import {
  EditorialDraftContractError,
  resolveEditorialDraftV3, applyContentPlanV3,
  type V3Validation
} from '../content-plan-v3.js';
import {
  AgentBearerFailure, verifiedAgentBearer, respondAgentBearerFailure
} from './agent-bearer-boundary.js';

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEM_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERATION = 'createAgentPost';
const LIMIT_TARGETS = 20;

type DraftInput = {
  projectId: string;
  contentFormat: 'TEXT_ONLY';
  publicationKind: 'FEED';
  internalTitle: string;
  bodyPlain: string;
  targetAccountIds: string[];
  mediaAssetIds: [];
  schedule: null;
};

type DraftReceipt = {
  agent_id: string; canonical_payload_hash: string;
  phase: string; post_id: string | null; result_json: string | null;
};

function error(code: string, message: string, status = 400): never {
  throw new AgentRegistryError(code, message, status);
}
function requestBody(raw: unknown): DraftInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    error('VALIDATION_ERROR', 'Ожидается JSON-объект черновика.');
  }
  const input = raw as Record<string, unknown>;
  const allowed = new Set([
    'projectId','contentFormat','publicationKind','internalTitle','bodyPlain',
    'targetAccountIds','mediaAssetIds','targetTextOverrides','schedule'
  ]);
  if (Object.keys(input).some(key=>!allowed.has(key))) {
    error('VALIDATION_ERROR','Переданы недопустимые или публикационные поля.');
  }
  if (typeof input.projectId!=='string'||!IDENTIFIER.test(input.projectId)) {
    error('VALIDATION_ERROR','Недопустимый projectId.');
  }
  if (input.contentFormat!=='TEXT_ONLY' ||
    (input.publicationKind!==undefined && input.publicationKind!=='FEED')) {
    error('FEATURE_NOT_ENABLED',
      'В A2b1 допускается только текстовый черновик FEED.',403);
  }
  if (typeof input.internalTitle!=='string' || !input.internalTitle.trim()
    || input.internalTitle.trim().length>160
    || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.internalTitle)) {
    error('VALIDATION_ERROR','Название: от 1 до 160 символов.');
  }
  if (typeof input.bodyPlain!=='string'||!input.bodyPlain.trim()
    || input.bodyPlain.length>20000
    || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.bodyPlain)) {
    error('VALIDATION_ERROR','Текст: от 1 до 20000 символов.');
  }
  if (!Array.isArray(input.targetAccountIds)
    || input.targetAccountIds.length<1 || input.targetAccountIds.length>LIMIT_TARGETS
    || input.targetAccountIds.some(x=>typeof x!=='string'||!IDENTIFIER.test(x))
    || new Set(input.targetAccountIds).size!==input.targetAccountIds.length) {
    error('VALIDATION_ERROR','Требуется 1–20 уникальных accountId.');
  }
  if (!Array.isArray(input.mediaAssetIds)||input.mediaAssetIds.length!==0
    || (input.schedule!==undefined && input.schedule!==null)
    || (input.targetTextOverrides!==undefined &&
      (!Array.isArray(input.targetTextOverrides)||input.targetTextOverrides.length!==0))) {
    error('FEATURE_NOT_ENABLED',
      'Медиа, расписание и индивидуальные версии текста появятся после проверки A2b.',403);
  }
  return {
    projectId:input.projectId,
    contentFormat:'TEXT_ONLY',
    publicationKind:'FEED',
    internalTitle:input.internalTitle.trim(),
    bodyPlain:input.bodyPlain.trim(),
    targetAccountIds:[...input.targetAccountIds].sort(),
    mediaAssetIds:[],
    schedule:null
  };
}

const hash=(s:string)=>crypto.createHash('sha256').update(s,'utf8').digest('hex');

function receiptId(agentId:string, idem:string) {
  return hash('AGENT\0'+agentId+'\0'+OPERATION+'\0'+idem);
}
function safeResponse(
  postId:string, input:DraftInput, contentVersion:number
) {
  return {
    postId, projectId:input.projectId, internalTitle:input.internalTitle,
    contentFormat:'TEXT_ONLY' as const, publicationKind:'FEED' as const,
    bodyPlain:input.bodyPlain, contentVersion,
    targetAccountIds:input.targetAccountIds, mediaAssetIds:[],
    targetTextOverrides:[], schedule:null, status:'DRAFT' as const,
    editorialStage:'DRAFT' as const
  };
}
function verifyTargetAuthorization(req:FastifyRequest,input:DraftInput) {
  const principal=verifiedAgentBearer(req);
  for(const accountId of input.targetAccountIds) {
    assertEffectiveAgentGrant({
      agentId:principal.agentId,
      grantVersion:principal.grantVersion,
      tokenVersion:principal.tokenVersion,
      tokenScopes:principal.tokenScopes,
      requiredScope:'posts:write',
      projectId:input.projectId,
      accountId
    });
  }
  return principal;
}

function buildSafeDraft(req:FastifyRequest,raw:unknown,idem:string) {
  const input=requestBody(raw);
  const normalizedHash=hash(JSON.stringify(input));
  // An immediate SQLite write transaction covers the grant recheck, canonical
  // content-plan mutation, immutable provenance, activity and durable receipt.
  // No post can become visible without its attribution and safe DRAFT state.
  return db.transaction(()=>{
    const principal=verifyTargetAuthorization(req,input);
    const keyHash=receiptId(principal.agentId,idem);
    const earlier=db.prepare([
      'SELECT agent_id,canonical_payload_hash,phase,post_id,result_json',
      'FROM agent_operation_receipts',
      'WHERE agent_id=? AND operation_name=? AND idempotency_key_hash=?'
    ].join(' ')).get(principal.agentId,OPERATION,keyHash) as DraftReceipt|undefined;
    if(earlier){
      if(earlier.canonical_payload_hash!==normalizedHash) {
        error('IDEMPOTENCY_CONFLICT','Ключ уже использован с другим черновиком.',409);
      }
      if(earlier.phase!=='COMPLETED'||!earlier.post_id||!earlier.result_json) {
        error('RECOVERY_NEEDED','Статус предыдущей операции требует проверки.',409);
      }
      const owner=db.prepare([
        'SELECT p.id FROM agent_draft_ownership o JOIN posts p ON p.id=o.post_id',
        'WHERE o.post_id=? AND o.agent_id=? AND p.source_type=?'
      ].join(' ')).get(earlier.post_id,principal.agentId,'agent-api');
      if(!owner)error('RESOURCE_DENIED','Черновик больше недоступен.',403);
      const original=JSON.parse(earlier.result_json) as {
        postId?:unknown; contentVersion?:unknown; status?:unknown
      };
      if(original.postId!==earlier.post_id||!Number.isSafeInteger(original.contentVersion)
        ||Number(original.contentVersion)<1||original.status!=='DRAFT') {
        error('RECOVERY_NEEDED','Исходная квитанция повреждена.',409);
      }
      return {replay:true,
        data:safeResponse(earlier.post_id,input,Number(original.contentVersion))};
    }
    const project=db.prepare('SELECT id,slug FROM projects WHERE id=?')
      .get(input.projectId) as {id:string;slug:string}|undefined;
    if(!project)error('RESOURCE_DENIED','Недоступный проект.',403);
    const normalized=resolveEditorialDraftV3({
      project:project.slug,
      internalTitle:input.internalTitle,
      body:input.bodyPlain,
      contentFormat:'TEXT_ONLY',
      publicationKind:'FEED',
      targets:input.targetAccountIds.map(accountId=>({accountId})),
      schedule:{mode:'MANUAL'}
    },{externalId:keyHash,sourceRevision:'agent-draft-v1'});
    if(normalized.projectId!==input.projectId||normalized.scheduleMode!=='MANUAL'
      ||normalized.scheduledAt!==null||normalized.contentFormat!=='TEXT_ONLY'
      ||normalized.targets.length!==input.targetAccountIds.length
      ||normalized.targets.some(t=>!input.targetAccountIds.includes(t.accountId))) {
      error('POLICY_DENIED','Канонический черновик нарушил политику.',403);
    }
    const validation:V3Validation={
      version:3,sourceId:principal.agentId,fileSha256:normalized.payloadHash,
      format:'csv',canApply:true,
      summary:{totalRows:1,newRows:1,updateRows:0,unchangedRows:0,
        conflicts:0,requests:0,errors:0},
      rows:[{rowNumber:1,classification:'NEW',errors:[],normalized}]
    };
    const applied=applyContentPlanV3(validation,{
      actorSource:'agent_api',
      sourceTypeOverride:'agent-api',
      afterRow:({postId})=>{
        db.prepare([
          'INSERT INTO agent_draft_ownership',
          '(post_id,agent_id,creation_grant_version,creation_operation_id,created_at)',
          'VALUES (?,?,?,?,?)'
        ].join(' ')).run(postId,principal.agentId,principal.grantVersion,OPERATION,nowIso());
      }
    });
    if(applied.created!==1||applied.postIds.length!==1) {
      error('POLICY_DENIED','Черновик не был создан атомарно.',409);
    }
    const postId=applied.postIds[0]!;
    const post=db.prepare([
      'SELECT content_version,status,editorial_stage,source_type,schedule_mode',
      'FROM posts WHERE id=?'
    ].join(' ')).get(postId) as {
      content_version:number;status:string;editorial_stage:string;
      source_type:string;schedule_mode:string
    }|undefined;
    if(!post || post.status!=='DRAFT'||post.editorial_stage!=='DRAFT'
      ||post.source_type!=='agent-api'||post.schedule_mode!=='MANUAL') {
      error('POLICY_DENIED','Небезопасный результат канонического редактора.',409);
    }
    const data=safeResponse(postId,input,post.content_version);
    db.prepare([
      'INSERT INTO agent_operation_receipts',
      '(receipt_id,agent_id,operation_name,idempotency_key_hash,',
      'canonical_payload_hash,post_id,phase,result_json,created_at,updated_at)',
      'VALUES (?,?,?,?,?,?,?,?,?,?)'
    ].join(' ')).run(id('arec'),principal.agentId,OPERATION,keyHash,
      normalizedHash,postId,'COMPLETED',
      JSON.stringify({postId,contentVersion:post.content_version,status:'DRAFT'}),
      nowIso(),nowIso());
    db.prepare([
      'INSERT INTO agent_activity_events',
      '(event_id,agent_id,actor_type,origin,request_id,operation_id,',
      'post_id,grant_version,stage,outcome,safe_summary,occurred_at)',
      "VALUES (?,?,'AGENT','REST',?,?,?,?,'COMPLETED','SUCCEEDED',?,?)"
    ].join(' ')).run(id('evt'),principal.agentId,'req_'+keyHash,OPERATION,
      postId,principal.grantVersion,'Агент создал текстовый черновик без публикации.',nowIso());
    return {replay:false,data};
  }).immediate();
}
function failure(reply:FastifyReply,e:unknown) {
  if(e instanceof AgentRegistryError) {
    const safe = e.code==='RESOURCE_DENIED'||e.code==='VALIDATION_ERROR'||
      e.code==='IDEMPOTENCY_CONFLICT'||e.code==='FEATURE_NOT_ENABLED'||
      e.code==='FORBIDDEN_SCOPE'||e.code==='POLICY_DENIED'||e.code==='RECOVERY_NEEDED';
    if(safe)return reply.code(e.status).send({
      error:{code:e.code,message:e.message},requestId:id('req'),retryable:false
    });
  }
  if(e instanceof EditorialDraftContractError) {
    return reply.code(400).send({
      error:{code:'VALIDATION_ERROR',message:'Некорректное содержимое черновика.'},
      requestId:id('req'),retryable:false
    });
  }
  if(e instanceof AgentBearerFailure) return respondAgentBearerFailure(reply,e);
  // Never return provider data, SQL internals or a stack to machine clients.
  return reply.code(500).send({
    error:{code:'INTERNAL_ERROR',message:'Черновик не создан.'},
    requestId:id('req'),retryable:true
  });
}

/** AGENT-A2b1: a single safe draft creation entrypoint, not a publisher. */
export async function registerAgentTextDraftRoutes(app:FastifyInstance):Promise<void> {
  app.post('/api/agent/v1/posts',{bodyLimit:65536},async(req,reply)=>{
    if(req.url.includes('?'))return failure(reply,
      new AgentRegistryError('VALIDATION_ERROR','Параметры URL запрещены.',400));
    const idem=req.headers['idempotency-key'];
    if(typeof idem!=='string'||!IDEM_KEY.test(idem)) {
      return failure(reply,
        new AgentRegistryError('VALIDATION_ERROR','Требуется Idempotency-Key.',400));
    }
    try{
      const result=buildSafeDraft(req,req.body,idem);
      return reply.code(result.replay?200:201).send(result.data);
    }catch(e){return failure(reply,e);}
  });
}
