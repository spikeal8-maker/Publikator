import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-schema-v12-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='schema-v12-password';
process.env.APP_MASTER_KEY='schema-v12-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {DATABASE_SCHEMA_VERSION}=await import('../dist/schema.js');
const {createDraftPost}=await import('../dist/post-creation.js');
const {serializeRichText,plainTextToRichText}=await import('../dist/rich-text.js');

migrate();
try{
  assert.equal(DATABASE_SCHEMA_VERSION,12);
  assert.equal(Number(db.pragma('user_version',{simple:true})),12);

  const project=db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
  const accountId=id('acc');
  const now=nowIso();
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`).run(accountId,'telegram','Schema12 target','encrypted',now,now);
  const post=createDraftPost({
    projectId:project.id,
    title:'Schema 12 preserved post',
    body:'Preserved body',
    bodyRichJson:serializeRichText(plainTextToRichText('Preserved body')),
    scheduleMode:'MANUAL',
    targetAccountIds:[accountId]
  });
  const mediaId=id('med');
  db.prepare(`INSERT INTO media
    (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      mediaId,post.id,'preserved.png',`${post.id}/preserved.png`,'image/png',1,1,1,'a'.repeat(64),now,0
    );
  const slotId=id('slot');
  db.prepare(`INSERT INTO schedule_slots
    (id,project_id,weekday,time_hhmm,timezone,enabled,last_fired_on,created_at)
    VALUES (?,?,?,?,?,1,NULL,?)`).run(slotId,project.id,1,'09:30','Europe/Moscow',now);

  db.exec('DROP TABLE templates');
  db.pragma('user_version = 11');

  const before={
    projects:db.prepare('SELECT * FROM projects ORDER BY id').all(),
    posts:db.prepare('SELECT * FROM posts ORDER BY id').all(),
    revisions:db.prepare('SELECT * FROM content_revisions ORDER BY id').all(),
    targets:db.prepare('SELECT * FROM post_targets ORDER BY id').all(),
    media:db.prepare('SELECT * FROM media ORDER BY id').all(),
    schedules:db.prepare('SELECT * FROM schedule_slots ORDER BY id').all()
  };

  migrate();
  assert.equal(Number(db.pragma('user_version',{simple:true})),12);
  const columns=db.prepare('PRAGMA table_info(templates)').all().map((row)=>row.name);
  for(const required of [
    'id','key','name','project_id','template_type','body_rich_json','body_plain',
    'publication_kind','content_format','schedule_mode','target_account_ids_json',
    'created_at','updated_at'
  ]) assert.ok(columns.includes(required),required);

  assert.deepEqual(db.prepare('SELECT * FROM projects ORDER BY id').all(),before.projects);
  assert.deepEqual(db.prepare('SELECT * FROM posts ORDER BY id').all(),before.posts);
  assert.deepEqual(db.prepare('SELECT * FROM content_revisions ORDER BY id').all(),before.revisions);
  assert.deepEqual(db.prepare('SELECT * FROM post_targets ORDER BY id').all(),before.targets);
  assert.deepEqual(db.prepare('SELECT * FROM media ORDER BY id').all(),before.media);
  assert.deepEqual(db.prepare('SELECT * FROM schedule_slots ORDER BY id').all(),before.schedules);

  migrate();
  assert.equal(Number(db.pragma('user_version',{simple:true})),12);
  console.log(JSON.stringify({
    ok:true,
    from:11,
    to:12,
    additiveTemplatesTable:true,
    projectsUnchanged:true,
    postsUnchanged:true,
    revisionsUnchanged:true,
    targetsUnchanged:true,
    mediaUnchanged:true,
    schedulesUnchanged:true,
    rerunSafe:true
  },null,2));
}finally{
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
