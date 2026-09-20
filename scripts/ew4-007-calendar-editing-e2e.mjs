import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-ew4-007-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='ew4-007-password';
process.env.APP_MASTER_KEY='ew4-007-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const {db,migrate}=await import('../dist/db.js');
const {buildApp}=await import('../dist/app.js');
const {markReadyRevision}=await import('../dist/content-versioning.js');
migrate();
assert.equal(Number(db.pragma('user_version',{simple:true})),12);

const app=await buildApp();
await app.ready();
const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}});
assert.equal(login.statusCode,200,login.body);
const cookie=String(login.headers['set-cookie']).split(';')[0];
async function api(method,url,payload,expected=200){
  const response=await app.inject({method,url,headers:{cookie},...(payload===undefined?{}:{payload})});
  assert.equal(response.statusCode,expected,method+' '+url+': '+response.body);
  return response.statusCode===204?null:response.json();
}
try{
  const project=(await api('GET','/api/projects'))[0];
  await api('PATCH','/api/projects/'+project.id,{defaultTimezone:'Europe/Moscow',defaultTargetAccountIds:[]});

  const at=await api('POST','/api/posts',{
    projectId:project.id,title:'Calendar AT reschedule',body:'AT body',
    scheduleMode:'AT',scheduledAt:'2026-10-15T07:30:00.000Z',scheduleTimezone:'Europe/Moscow'
  },201);
  assert.equal(at.content_version,1);
  assert.equal(at.schedule_timezone,'Europe/Moscow');

  const projection=await api('GET','/api/calendar?from=2026-10-15T00%3A00%3A00.000Z&to=2026-10-16T00%3A00%3A00.000Z');
  const projected=projection.items.find((item)=>item.id===at.id);
  assert.ok(projected);
  assert.equal(projected.project_id,project.id);
  assert.equal(projected.content_version,1);
  assert.equal(projected.schedule_mode,'AT');

  const moved=await api('PATCH','/api/posts/'+at.id,{
    scheduleMode:'AT',scheduledAt:'2026-10-15T09:00:00.000Z',
    scheduleTimezone:'Europe/Moscow',expectedContentVersion:1
  });
  assert.equal(moved.contentVersion,2);
  assert.equal(moved.post.scheduled_at_utc,'2026-10-15T09:00:00.000Z');
  assert.equal(moved.post.schedule_timezone,'Europe/Moscow');

  const stale=await api('PATCH','/api/posts/'+at.id,{
    scheduleMode:'AT',scheduledAt:'2026-10-15T10:00:00.000Z',
    scheduleTimezone:'Europe/Moscow',expectedContentVersion:1
  },409);
  assert.match(String(stale.error),/Версия поста|устарел/);
  const ready=await api('POST','/api/posts',{
    projectId:project.id,title:'Calendar READY reschedule',body:'READY body',
    scheduleMode:'AT',scheduledAt:'2026-10-16T07:00:00.000Z',scheduleTimezone:'Europe/Moscow'
  },201);
  const readyRevision=db.prepare('SELECT id FROM content_revisions WHERE post_id=? AND content_version=1').get(ready.id);
  markReadyRevision(ready.id,1,readyRevision.id);
  let readyRow=db.prepare('SELECT status,editorial_stage,ready_revision_id,content_version FROM posts WHERE id=?').get(ready.id);
  assert.equal(readyRow.status,'READY');
  assert.equal(readyRow.content_version,1);
  assert.ok(readyRow.ready_revision_id);

  const readyMoved=await api('PATCH','/api/posts/'+ready.id,{
    scheduleMode:'AT',scheduledAt:'2026-10-16T08:00:00.000Z',
    scheduleTimezone:'Europe/Moscow',expectedContentVersion:1
  });
  assert.equal(readyMoved.contentVersion,2);
  readyRow=db.prepare('SELECT status,editorial_stage,ready_revision_id,content_version,schedule_timezone FROM posts WHERE id=?').get(ready.id);
  assert.equal(readyRow.status,'DRAFT');
  assert.equal(readyRow.editorial_stage,'DRAFT');
  assert.equal(readyRow.ready_revision_id,null);
  assert.equal(readyRow.content_version,2);
  assert.equal(readyRow.schedule_timezone,'Europe/Moscow');

  const queued=await api('POST','/api/posts',{
    projectId:project.id,title:'Calendar QUEUE',body:'QUEUE body',scheduleMode:'QUEUE'
  },201);
  const queueProjection=await api('GET','/api/calendar?from=2026-10-01T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z');
  const queueItem=queueProjection.queueItems.find((item)=>item.id===queued.id);
  assert.ok(queueItem);
  assert.equal(queueItem.project_id,project.id);
  assert.equal(queueItem.content_version,1);
  assert.equal(queueItem.schedule_mode,'QUEUE');
  assert.equal(queueProjection.items.some((item)=>item.id===queued.id),false);
  const blockedQueue=await api('PATCH','/api/posts/'+queued.id,{
    scheduleMode:'AT',scheduledAt:'2026-10-17T12:00:00.000Z',expectedContentVersion:1
  },409);
  assert.equal(blockedQueue.error,'QUEUE_TO_AT_CONFIRMATION_REQUIRED');

  const confirmedQueue=await api('PATCH','/api/posts/'+queued.id,{
    scheduleMode:'AT',scheduledAt:'2026-10-17T12:00:00.000Z',
    confirmQueueToAt:true,expectedContentVersion:1
  });
  assert.equal(confirmedQueue.contentVersion,2);
  assert.equal(confirmedQueue.post.schedule_mode,'AT');
  assert.equal(confirmedQueue.post.scheduled_at_utc,'2026-10-17T12:00:00.000Z');

  const published=await api('POST','/api/posts',{
    projectId:project.id,title:'Calendar immutable',body:'immutable',
    scheduleMode:'AT',scheduledAt:'2026-10-18T07:00:00.000Z',scheduleTimezone:'Europe/Moscow'
  },201);
  db.prepare("UPDATE posts SET status='PUBLISHED',editorial_stage='APPROVED' WHERE id=?").run(published.id);
  await api('PATCH','/api/posts/'+published.id,{
    scheduleMode:'AT',scheduledAt:'2026-10-18T08:00:00.000Z',
    scheduleTimezone:'Europe/Moscow',expectedContentVersion:1
  },409);

  const exactSlot='2026-10-19T13:00:00.000Z';
  const createdFromSlot=await api('POST','/api/posts',{
    projectId:project.id,title:'Calendar exact slot',body:'slot body',
    scheduleMode:'AT',scheduledAt:exactSlot
  },201);
  assert.equal(createdFromSlot.scheduled_at_utc,exactSlot);
  assert.equal(createdFromSlot.schedule_timezone,'Europe/Moscow');
  assert.equal(createdFromSlot.content_version,1);
  const quickEdited=await api('PATCH','/api/posts/'+createdFromSlot.id,{
    scheduleMode:'AT',scheduledAtLocal:'2026-10-20T10:15',
    scheduleTimezone:'Europe/Moscow',expectedContentVersion:1
  });
  assert.equal(quickEdited.contentVersion,2);
  assert.equal(quickEdited.post.schedule_timezone,'Europe/Moscow');
  assert.equal(quickEdited.post.scheduled_at_utc,'2026-10-20T07:15:00.000Z');

  console.log(JSON.stringify({
    ok:true,checkpoint:'EW4-007',schemaVersion:12,
    calendarProjectionVersioned:true,queueProjection:true,
    atReschedule:true,timezonePreserved:true,
    contentVersionIncrement:true,readyInvalidation:true,
    staleConflict:true,queueToAtGuard:true,queueToAtConfirmed:true,
    immutablePublishedBlocked:true,exactSlotCreate:true,quickEditCanonicalPath:true
  },null,2));
}finally{
  await app.close();
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
