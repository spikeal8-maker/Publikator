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
const {listPlatformCapabilities}=await import('../dist/platforms/capabilities.js');
migrate();

const app=await buildApp();
await app.ready();

const platformOptionSchemas=Object.fromEntries(
  listPlatformCapabilities().map((capability)=>[capability.platform,capability.platformOptionsSchema])
);
assert.deepEqual(platformOptionSchemas,{telegram:{},vk:{},max:{},instagram:{}});

const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:process.env.ADMIN_PASSWORD}});
assert.equal(login.statusCode,200,login.body);
const cookie=String(login.headers['set-cookie']).split(';')[0];

async function api(method,url,payload,expected=200){
  const response=await app.inject({method,url,headers:{cookie},...(payload===undefined?{}:{payload})});
  assert.equal(response.statusCode,expected,`${method} ${url}: ${response.body}`);
  return response;
}

const sortedIds=(values)=>[...values].sort();
const enabledTargetIds=(post)=>sortedIds(post.targets.filter((target)=>Boolean(target.enabled)).map((target)=>target.account_id));

try{
  let projects=(await api('GET','/api/projects')).json();
  assert.ok(projects.length>=1);
  assert.ok(projects.every((project)=>typeof project.default_timezone==='string'));
  assert.ok(projects.every((project)=>Array.isArray(project.defaultTargetAccountIds)));
  const mainProject=projects[0];
  assert.equal(mainProject.default_targets_explicit,0);
  assert.deepEqual(mainProject.defaultTargetAccountIds,[]);

  const telegram=(await api('POST','/api/accounts',{
    platform:'telegram',name:'A3 Telegram',credentials:{token:'telegram'}
  },201)).json();
  projects=(await api('GET','/api/projects')).json();
  let main=projects.find((project)=>project.id===mainProject.id);
  assert.equal(main.default_targets_explicit,0);
  assert.deepEqual(main.defaultTargetAccountIds,[telegram.id]);

  const vk=(await api('POST','/api/accounts',{
    platform:'vk',
    name:'A3 VK',
    credentials:{
      accessToken:'ew4-005a1-vk-token',
      destinationKind:'COMMUNITY',
      groupId:'12345',
      apiVersion:'5.199'
    }
  },201)).json();
  projects=(await api('GET','/api/projects')).json();
  main=projects.find((project)=>project.id===mainProject.id);
  assert.deepEqual(sortedIds(main.defaultTargetAccountIds),sortedIds([telegram.id,vk.id]));

  const freshInheritedPost=(await api('POST','/api/posts',{
    projectId:mainProject.id,
    title:'Fresh project target inheritance',
    body:'Fresh project must inherit Telegram and VK'
  },201)).json();
  assert.deepEqual(enabledTargetIds(freshInheritedPost),sortedIds([telegram.id,vk.id]));

  await api('PATCH',`/api/accounts/${vk.id}`,{enabled:false});
  const disabledFilteredPost=(await api('POST','/api/posts',{
    projectId:mainProject.id,
    title:'Disabled target filter',
    body:'Disabled default account must not become an enabled post target'
  },201)).json();
  assert.deepEqual(enabledTargetIds(disabledFilteredPost),[telegram.id]);
  await api('PATCH',`/api/accounts/${vk.id}`,{enabled:true});

  const explicitEmpty=(await api('PATCH',`/api/projects/${mainProject.id}`,{
    defaultTargetAccountIds:[]
  })).json();
  assert.equal(explicitEmpty.default_targets_explicit,1);
  assert.deepEqual(explicitEmpty.defaultTargetAccountIds,[]);

  const max=(await api('POST','/api/accounts',{
    platform:'max',name:'A3 MAX',credentials:{token:'max'}
  },201)).json();
  main=(await api('GET','/api/projects')).json().find((project)=>project.id===mainProject.id);
  assert.equal(main.default_targets_explicit,1);
  assert.deepEqual(main.defaultTargetAccountIds,[]);

  const emptyInheritedPost=(await api('POST','/api/posts',{
    projectId:mainProject.id,
    title:'Explicit empty target inheritance',
    body:'Explicit empty project defaults must stay empty'
  },201)).json();
  assert.deepEqual(enabledTargetIds(emptyInheritedPost),[]);

  const explicitSubset=(await api('PATCH',`/api/projects/${mainProject.id}`,{
    defaultTargetAccountIds:[telegram.id]
  })).json();
  assert.equal(explicitSubset.default_targets_explicit,1);
  assert.deepEqual(explicitSubset.defaultTargetAccountIds,[telegram.id]);

  const instagram=(await api('POST','/api/accounts',{
    platform:'instagram',name:'A3 Instagram',credentials:{token:'instagram'}
  },201)).json();
  assert.ok(instagram.id);
  main=(await api('GET','/api/projects')).json().find((project)=>project.id===mainProject.id);
  assert.deepEqual(main.defaultTargetAccountIds,[telegram.id]);

  const defaultsProject=(await api('POST','/api/projects',{
    name:'Default targets project',
    slug:'default-targets-project'
  },201)).json();
  assert.equal(defaultsProject.default_targets_explicit,0);
  assert.deepEqual(
    sortedIds(defaultsProject.defaultTargetAccountIds),
    sortedIds([telegram.id,vk.id,max.id,instagram.id])
  );

  await api('PATCH',`/api/projects/${defaultsProject.id}`,{
    defaultTargetAccountIds:'not-an-array'
  },400);

  const explicitDefaults=(await api('PATCH',`/api/projects/${defaultsProject.id}`,{
    defaultTargetAccountIds:[telegram.id,vk.id,telegram.id]
  })).json();
  assert.equal(explicitDefaults.default_targets_explicit,1);
  assert.deepEqual(sortedIds(explicitDefaults.defaultTargetAccountIds),sortedIds([telegram.id,vk.id]));

  const emptyDefaults=(await api('PATCH',`/api/projects/${defaultsProject.id}`,{
    defaultTargetAccountIds:[]
  })).json();
  assert.equal(emptyDefaults.default_targets_explicit,1);
  assert.deepEqual(emptyDefaults.defaultTargetAccountIds,[]);

  await api('PATCH',`/api/projects/${defaultsProject.id}`,{
    defaultTargetAccountIds:['acc_missing']
  },400);
  const afterUnknown=(await api('GET','/api/projects')).json().find((project)=>project.id===defaultsProject.id);
  assert.deepEqual(afterUnknown.defaultTargetAccountIds,[]);

  const restoredDefaults=(await api('PATCH',`/api/projects/${defaultsProject.id}`,{
    defaultTargetAccountIds:[telegram.id,vk.id]
  })).json();
  assert.deepEqual(sortedIds(restoredDefaults.defaultTargetAccountIds),sortedIds([telegram.id,vk.id]));

  const inheritedTargetsPost=(await api('POST','/api/posts',{
    projectId:defaultsProject.id,
    title:'Inherited project targets',
    body:'Telegram and VK must be selected from project defaults'
  },201)).json();
  assert.deepEqual(enabledTargetIds(inheritedTargetsPost),sortedIds([telegram.id,vk.id]));

  const overriddenTargets=(await api('PUT',`/api/posts/${inheritedTargetsPost.id}/targets`,{
    accountIds:[max.id],
    expectedContentVersion:1
  })).json();
  assert.deepEqual(enabledTargetIds(overriddenTargets),[max.id]);
  const projectAfterOverride=(await api('GET','/api/projects')).json().find((project)=>project.id===defaultsProject.id);
  assert.deepEqual(sortedIds(projectAfterOverride.defaultTargetAccountIds),sortedIds([telegram.id,vk.id]));

  const safetyProject=(await api('POST','/api/projects',{
    name:'Existing post safety',
    slug:'existing-post-safety'
  },201)).json();
  await api('PATCH',`/api/projects/${safetyProject.id}`,{
    defaultTargetAccountIds:[telegram.id]
  });
  const postA=(await api('POST','/api/posts',{
    projectId:safetyProject.id,
    title:'Post A',
    body:'Old post must keep its inherited targets'
  },201)).json();
  assert.deepEqual(enabledTargetIds(postA),[telegram.id]);
  const postATargetsBefore=db.prepare(`SELECT account_id,enabled,state FROM post_targets
    WHERE post_id=? ORDER BY account_id`).all(postA.id);
  const postAVersionBefore=db.prepare('SELECT content_version FROM posts WHERE id=?').get(postA.id).content_version;
  const postARevisionCountBefore=db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(postA.id).count;

  const changedDefaults=(await api('PATCH',`/api/projects/${safetyProject.id}`,{
    defaultTargetAccountIds:[vk.id,max.id]
  })).json();
  assert.deepEqual(sortedIds(changedDefaults.defaultTargetAccountIds),sortedIds([vk.id,max.id]));

  const postAAfter=(await api('GET',`/api/posts/${postA.id}`)).json();
  assert.deepEqual(enabledTargetIds(postAAfter),[telegram.id]);
  assert.deepEqual(
    db.prepare(`SELECT account_id,enabled,state FROM post_targets WHERE post_id=? ORDER BY account_id`).all(postA.id),
    postATargetsBefore
  );
  assert.equal(db.prepare('SELECT content_version FROM posts WHERE id=?').get(postA.id).content_version,postAVersionBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(postA.id).count,postARevisionCountBefore);

  const postB=(await api('POST','/api/posts',{
    projectId:safetyProject.id,
    title:'Post B',
    body:'New post must see changed project defaults'
  },201)).json();
  assert.deepEqual(enabledTargetIds(postB),sortedIds([vk.id,max.id]));
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

  const inheritedPost=(await api('POST','/api/posts',{
    projectId:moscowProject.id,
    title:'Inherited project timezone',
    body:'Project timezone must become the AT post default',
    scheduleMode:'AT',
    scheduledAtLocal:'2026-10-01T18:00'
  },201)).json();
  assert.equal(inheritedPost.content_version,1);
  assert.equal(inheritedPost.schedule_timezone,'Europe/Moscow');
  assert.equal(inheritedPost.scheduled_at_utc,'2026-10-01T15:00:00.000Z');

  const explicitPost=(await api('POST','/api/posts',{
    projectId:moscowProject.id,
    title:'Explicit timezone override',
    body:'Explicit timezone must beat project default',
    scheduleMode:'AT',
    scheduledAtLocal:'2026-10-01T18:00',
    scheduleTimezone:'Asia/Tokyo'
  },201)).json();
  assert.equal(explicitPost.content_version,1);
  assert.equal(explicitPost.schedule_timezone,'Asia/Tokyo');
  assert.equal(explicitPost.scheduled_at_utc,'2026-10-01T09:00:00.000Z');

  const invalidExplicit=await api('POST','/api/posts',{
    projectId:moscowProject.id,
    title:'Invalid explicit timezone',
    body:'Invalid explicit timezone must still fail',
    scheduleMode:'AT',
    scheduledAtLocal:'2026-10-01T18:00',
    scheduleTimezone:'Mars/Olympus'
  },400);
  assert.match(invalidExplicit.json().error,/Invalid IANA timezone: Mars\/Olympus/);

  const before=db.prepare(`SELECT id,project_id,content_version,schedule_mode,scheduled_at,scheduled_at_utc,schedule_timezone
    FROM posts WHERE id=?`).get(inheritedPost.id);
  const revisionCountBefore=db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(inheritedPost.id).count;

  const patched=(await api('PATCH',`/api/projects/${moscowProject.id}`,{
    defaultTimezone:'Asia/Tokyo'
  })).json();
  assert.equal(patched.default_timezone,'Asia/Tokyo');

  const after=db.prepare(`SELECT id,project_id,content_version,schedule_mode,scheduled_at,scheduled_at_utc,schedule_timezone
    FROM posts WHERE id=?`).get(inheritedPost.id);
  const revisionCountAfter=db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(inheritedPost.id).count;

  assert.deepEqual(after,before);
  assert.equal(after.content_version,1);
  assert.equal(after.schedule_timezone,'Europe/Moscow');
  assert.equal(revisionCountAfter,revisionCountBefore);

  projects=(await api('GET','/api/projects')).json();
  assert.equal(projects.find((project)=>project.id===moscowProject.id).default_timezone,'Asia/Tokyo');

  console.log(JSON.stringify({
    ok:true,
    checkpoint:'EW4-005A3',
    schemaVersion:Number(db.pragma('user_version',{simple:true})),
    migrationDefaultTargetBackfill:true,
    freshProjectAccountInheritance:true,
    explicitEmptyPreserved:true,
    explicitSubsetPreserved:true,
    disabledAccountExcluded:true,
    platformOptionsExtensionPoint:true,
    currentPlatformOptionSchemasEmpty:true,
    newProjectInitialDefaults:true,
    patchExplicitDefaults:true,
    patchEmptyDefaults:true,
    unknownAccountRejected:true,
    newPostInheritsDefaults:true,
    perPostOverrideIsolation:true,
    oldPostUnchanged:true,
    newPostSeesChangedDefaults:true,
    createDefaultUtc:true,
    createExplicitTimezone:true,
    invalidTimezone400:true,
    patchTimezone:true,
    projectTimezoneInherited:true,
    inheritedUtcInstant:true,
    explicitTimezoneOverride:true,
    invalidExplicitTimezone400:true,
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
