import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-backup-v12-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='backup-v12-password';
process.env.APP_MASTER_KEY='backup-v12-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const {db,migrate}=await import('../dist/db.js');
const {config}=await import('../dist/config.js');
const {createTemplate}=await import('../dist/templates.js');
const {createBackupBundle,resolveBackupBundle,stageRestoreBundle}=await import('../dist/backups.js');
const {applyPendingRestore}=await import('../dist/restore-bootstrap.js');

migrate();
assert.equal(Number(db.pragma('user_version',{simple:true})),12);
const project=db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
const template=createTemplate({
  key:'backup-template',
  name:'Backup template',
  projectId:project.id,
  bodyRich:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Backup rich body',marks:[{type:'bold'}]}]}]},
  publicationKind:'FEED',
  contentFormat:'TEXT_ONLY',
  scheduleMode:'MANUAL',
  targetAccountIds:[]
});
const before=db.prepare('SELECT * FROM templates WHERE id=?').get(template.id);
const bundle=await createBackupBundle('schema12-templates');
const bundlePath=resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size>0);

db.prepare('UPDATE templates SET name=?,body_plain=? WHERE id=?').run('Mutated','Mutated',template.id);
db.prepare('DELETE FROM templates WHERE id=?').run(template.id);

const staged=await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion,12);
db.close();

const applied=await applyPendingRestore();
assert.equal(applied.applied,true);

const restored=new Database(config.dbPath,{readonly:true,fileMustExist:true});
try{
  assert.equal(Number(restored.pragma('user_version',{simple:true})),12);
  assert.deepEqual(restored.prepare('SELECT * FROM templates WHERE id=?').get(template.id),before);
  console.log(JSON.stringify({
    ok:true,
    schemaVersion:12,
    templatesRestored:true,
    canonicalBackupRestore:true
  },null,2));
}finally{
  restored.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
