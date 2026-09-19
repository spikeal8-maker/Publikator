import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-ew4-006-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='ew4-006-password';
process.env.APP_MASTER_KEY='ew4-006-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const {db,migrate}=await import('../dist/db.js');
const {buildApp}=await import('../dist/app.js');
migrate();
assert.equal(Number(db.pragma('user_version',{simple:true})),12);

const app=await buildApp();
await app.ready();
const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}});
assert.equal(login.statusCode,200,login.body);
const cookie=String(login.headers['set-cookie']).split(';')[0];

async function api(method,url,payload,expected=200){
  const response=await app.inject({method,url,headers:{cookie},...(payload===undefined?{}:{payload})});
  assert.equal(response.statusCode,expected,`${method} ${url}: ${response.body}`);
  return response.statusCode===204?null:response.json();
}
const enabledTargetIds=(post)=>post.targets.filter((target)=>Boolean(target.enabled)).map((target)=>target.account_id).sort();
try{
  const project=(await api('GET','/api/projects'))[0];
  const telegram=await api('POST','/api/accounts',{platform:'telegram',name:'Template TG',credentials:{token:'tg'}},201);
  const vk=await api('POST','/api/accounts',{platform:'vk',name:'Template VK',credentials:{token:'vk'}},201);
  const max=await api('POST','/api/accounts',{platform:'max',name:'Template MAX',credentials:{token:'max'}},201);

  await api('PATCH',`/api/projects/${project.id}`,{
    defaultTimezone:'Europe/Moscow',
    defaultTargetAccountIds:[telegram.id,vk.id]
  });

  const fallbackRich={type:'doc',content:[{type:'paragraph',content:[
    {type:'text',text:'Fallback ',marks:[]},
    {type:'text',text:'rich',marks:[{type:'bold'}]}
  ]}]};
  const fallback=await api('POST','/api/templates',{
    key:'fallback-template',
    name:'Fallback template',
    projectId:project.id,
    bodyRich:fallbackRich,
    publicationKind:'FEED',
    contentFormat:'IMAGE',
    scheduleMode:'MANUAL'
  },201);
  assert.equal(fallback.targetAccountIds,null);
  assert.equal(fallback.bodyPlain,'Fallback rich');
  assert.deepEqual(fallback.bodyRich,fallbackRich);
  const fallbackCreated=await api('POST',`/api/templates/${fallback.id}/create-post`,{},201);
  assert.deepEqual(fallbackCreated.warnings,[]);
  const fallbackPost=await api('GET',`/api/posts/${fallbackCreated.postId}`);
  assert.equal(fallbackPost.status,'DRAFT');
  assert.equal(fallbackPost.editorial_stage,'DRAFT');
  assert.equal(fallbackPost.content_version,1);
  assert.equal(fallbackPost.body,'Fallback rich');
  assert.deepEqual(enabledTargetIds(fallbackPost),[telegram.id,vk.id].sort());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(fallbackPost.id).count,1);

  const v1Rich={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Версия 1',marks:[{type:'italic'}]}]}]};
  const explicit=await api('POST','/api/templates',{
    key:'snapshot-template',
    name:'Snapshot template',
    projectId:project.id,
    bodyRich:v1Rich,
    publicationKind:'FEED',
    contentFormat:'IMAGE',
    scheduleMode:'QUEUE',
    targetAccountIds:[telegram.id,vk.id]
  },201);
  assert.deepEqual(explicit.targetAccountIds,[telegram.id,vk.id]);

  const createdA=await api('POST',`/api/templates/${explicit.id}/create-post`,{},201);
  const postA=await api('GET',`/api/posts/${createdA.postId}`);
  assert.equal(postA.body,'Версия 1');
  assert.equal(postA.schedule_mode,'QUEUE');
  assert.deepEqual(enabledTargetIds(postA),[telegram.id,vk.id].sort());
  const postABefore={
    body:postA.body,
    bodyRich:postA.bodyRich,
    targets:enabledTargetIds(postA),
    revisionCount:db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(postA.id).count
  };

  const v2Rich={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Версия 2',marks:[{type:'bold'}]}]}]};
  const updated=await api('PATCH',`/api/templates/${explicit.id}`,{
    bodyRich:v2Rich,
    scheduleMode:'MANUAL',
    targetAccountIds:[max.id]
  });
  assert.equal(updated.bodyPlain,'Версия 2');
  assert.deepEqual(updated.targetAccountIds,[max.id]);

  const postAAfter=await api('GET',`/api/posts/${postA.id}`);
  assert.equal(postAAfter.body,postABefore.body);
  assert.deepEqual(postAAfter.bodyRich,postABefore.bodyRich);
  assert.deepEqual(enabledTargetIds(postAAfter),postABefore.targets);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(postA.id).count,postABefore.revisionCount);

  const createdB=await api('POST',`/api/templates/${explicit.id}/create-post`,{},201);
  const postB=await api('GET',`/api/posts/${createdB.postId}`);
  assert.equal(postB.body,'Версия 2');
  assert.deepEqual(postB.bodyRich,v2Rich);
  assert.deepEqual(enabledTargetIds(postB),[max.id]);
  const projectAfter=(await api('GET','/api/projects')).find((item)=>item.id===project.id);
  assert.deepEqual([...projectAfter.defaultTargetAccountIds].sort(),[telegram.id,vk.id].sort());

  const temporary=await api('POST','/api/accounts',{platform:'instagram',name:'Temporary target',credentials:{token:'temp'}},201);
  const unavailable=await api('POST','/api/templates',{
    key:'unavailable-target-template',
    name:'Unavailable target template',
    projectId:project.id,
    bodyRich:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Safe target',marks:[]}]}]},
    publicationKind:'FEED',
    contentFormat:'TEXT_ONLY',
    scheduleMode:'MANUAL',
    targetAccountIds:[telegram.id,temporary.id]
  },201);
  await api('PATCH',`/api/accounts/${temporary.id}`,{enabled:false});
  const disabledCreated=await api('POST',`/api/templates/${unavailable.id}/create-post`,{},201);
  assert.deepEqual(enabledTargetIds(await api('GET',`/api/posts/${disabledCreated.postId}`)),[telegram.id]);
  assert.deepEqual(disabledCreated.warnings,[{
    code:'TEMPLATE_TARGET_UNAVAILABLE',accountId:temporary.id,reason:'disabled'
  }]);

  db.prepare('DELETE FROM social_accounts WHERE id=?').run(temporary.id);
  const missingCreated=await api('POST',`/api/templates/${unavailable.id}/create-post`,{},201);
  assert.deepEqual(enabledTargetIds(await api('GET',`/api/posts/${missingCreated.postId}`)),[telegram.id]);
  assert.deepEqual(missingCreated.warnings,[{
    code:'TEMPLATE_TARGET_UNAVAILABLE',accountId:temporary.id,reason:'missing'
  }]);
  const atTemplate=await api('POST','/api/templates',{
    key:'at-template',
    name:'AT template',
    projectId:project.id,
    bodyRich:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Choose time later',marks:[]}]}]},
    publicationKind:'FEED',
    contentFormat:'TEXT_ONLY',
    scheduleMode:'AT',
    targetAccountIds:[]
  },201);
  const atCreated=await api('POST',`/api/templates/${atTemplate.id}/create-post`,{},201);
  const atPost=await api('GET',`/api/posts/${atCreated.postId}`);
  assert.equal(atPost.status,'DRAFT');
  assert.equal(atPost.schedule_mode,'AT');
  assert.equal(atPost.scheduled_at,null);
  assert.equal(atPost.scheduled_at_utc,null);
  assert.equal(atPost.schedule_timezone,'Europe/Moscow');
  assert.deepEqual(enabledTargetIds(atPost),[]);

  const audit=db.prepare(`SELECT event_type,data_json FROM publication_events
    WHERE post_id=? AND event_type='template.applied' ORDER BY created_at DESC LIMIT 1`).get(postA.id);
  assert.equal(audit.event_type,'template.applied');
  assert.deepEqual(JSON.parse(audit.data_json),{
    postId:postA.id,
    templateId:explicit.id,
    templateKey:'snapshot-template'
  });

  const disposable=await api('POST','/api/templates',{
    key:'delete-me',name:'Delete me',projectId:project.id,
    bodyRich:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Delete body',marks:[]}]}]},
    publicationKind:'FEED',contentFormat:'TEXT_ONLY',scheduleMode:'MANUAL',targetAccountIds:[]
  },201);
  await api('DELETE',`/api/templates/${disposable.id}`,undefined,204);
  assert.ok(!(await api('GET','/api/templates')).some((item)=>item.id===disposable.id));

  console.log(JSON.stringify({
    ok:true,
    checkpoint:'EW4-006',
    schemaVersion:12,
    templateCrud:true,
    canonicalRichText:true,
    createPostFromTemplate:true,
    projectDefaultFallback:true,
    explicitTemplateTargets:true,
    disabledMissingTargetSafe:true,
    initialContentRevision:true,
    postDraft:true,
    snapshotV1Preserved:true,
    newPostUsesV2:true,
    atWithoutAbsoluteTime:true,
    auditEvent:true
  },null,2));
}finally{
  await app.close();
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
