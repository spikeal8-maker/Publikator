import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-ew4-005a1-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='ew4-005a1-ci-password';
process.env.APP_MASTER_KEY='ew4-005a1-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const {db,migrate}=await import('../dist/db.js');
const {buildApp}=await import('../dist/app.js');
migrate();

const app=await buildApp();
await app.ready();

const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}});
assert.equal(login.statusCode,200,login.body);
const cookie=String(login.headers['set-cookie']).split(';')[0];

async function api(method,url,payload,expected=200){
  const response=await app.inject({method,url,headers:{cookie},...(payload===undefined?{}:{payload})});
  assert.equal(response.statusCode,expected,`${method} ${url}: ${response.body}`);
  return response;
}

try{
  const initialProjects=(await api('GET','/api/projects')).json();
  assert.ok(initialProjects.length>=1);
  assert.ok(initialProjects.every((project)=>typeof project.default_timezone==='string'));

  const utcProject=(await api('POST','/api/projects',{
    name:'UTC project',
    slug:'utc-project'
  },201)).json();
  assert.equal(utcProject.default_timezone,'UTC');

  const moscowProject=(await api('POST','/api/projects',{
    name:'Moscow project',
    slug:'moscow-project',
    defaultTimezone:'Europe/Moscow'
  },201)).json();
  assert.equal(moscowProject.default_timezone,'Europe/Moscow');

  const invalid=await api('POST','/api/projects',{
    name:'Invalid timezone project',
    slug:'invalid-timezone-project',
    defaultTimezone:'Mars/Olympus'
  },400);
  assert.match(invalid.json().error,/Invalid IANA timezone: Mars\/Olympus/);

  const post=(await api('POST','/api/posts',{
    projectId:moscowProject.id,
    title:'Existing scheduled post',
    body:'Timezone must stay on the post',
    scheduleMode:'AT',
    scheduledAtLocal:'2026-11-02T10:00',
    scheduleTimezone:'America/New_York'
  },201)).json();
  assert.equal(post.content_version,1);
  assert.equal(post.schedule_timezone,'America/New_York');

  const before=db.prepare(`SELECT id,project_id,content_version,schedule_mode,scheduled_at,scheduled_at_utc,schedule_timezone
    FROM posts WHERE id=?`).get(post.id);
  const revisionCountBefore=db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(post.id).count;

  const patched=(await api('PATCH',`/api/projects/${moscowProject.id}`,{
    defaultTimezone:'Asia/Tokyo'
  })).json();
  assert.equal(patched.default_timezone,'Asia/Tokyo');

  const after=db.prepare(`SELECT id,project_id,content_version,schedule_mode,scheduled_at,scheduled_at_utc,schedule_timezone
    FROM posts WHERE id=?`).get(post.id);
  const revisionCountAfter=db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(post.id).count;

  assert.deepEqual(after,before);
  assert.equal(after.content_version,1);
  assert.equal(after.schedule_timezone,'America/New_York');
  assert.equal(revisionCountAfter,revisionCountBefore);

  const projects=(await api('GET','/api/projects')).json();
  assert.equal(projects.find((project)=>project.id===moscowProject.id).default_timezone,'Asia/Tokyo');

  console.log(JSON.stringify({
    ok:true,
    checkpoint:'EW4-005A1',
    schemaVersion:Number(db.pragma('user_version',{simple:true})),
    createDefaultUtc:true,
    createExplicitTimezone:true,
    invalidTimezone400:true,
    patchTimezone:true,
    existingPostUnchanged:true,
    postContentVersionUnchanged:true,
    noContentRevisionCreated:true,
    postScheduleTimezoneUnchanged:true
  },null,2));
}finally{
  await app.close();
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
