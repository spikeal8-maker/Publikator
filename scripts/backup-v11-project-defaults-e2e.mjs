import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'publikator-backup-v11-'));
process.env.NODE_ENV='test';
process.env.DATA_DIR=dataDir;
process.env.ADMIN_PASSWORD='backup-v11-ci-password';
process.env.APP_MASTER_KEY='backup-v11-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL='https://publisher.example.test';

const {db,migrate,id,nowIso}=await import('../dist/db.js');
const {config}=await import('../dist/config.js');
const {createBackupBundle,resolveBackupBundle,stageRestoreBundle}=await import('../dist/backups.js');
const {applyPendingRestore}=await import('../dist/restore-bootstrap.js');

migrate();
assert.equal(Number(db.pragma('user_version',{simple:true})),11);

const projectId=id('prj');
db.prepare('INSERT INTO projects(id,name,slug,default_timezone,created_at) VALUES (?,?,?,?,?)')
  .run(projectId,'Backup v11 project','backup-v11-project','Asia/Tokyo',nowIso());

const before=db.prepare('SELECT id,name,slug,default_timezone,created_at FROM projects WHERE id=?').get(projectId);
const bundle=await createBackupBundle('schema11-project-defaults');
const bundlePath=resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size>0);

db.prepare('UPDATE projects SET default_timezone=? WHERE id=?').run('UTC',projectId);

const staged=await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion,11);
db.close();

const applied=await applyPendingRestore();
assert.equal(applied.applied,true);

const restored=new Database(config.dbPath,{readonly:true,fileMustExist:true});
try{
  assert.equal(Number(restored.pragma('user_version',{simple:true})),11);
  assert.deepEqual(
    restored.prepare('SELECT id,name,slug,default_timezone,created_at FROM projects WHERE id=?').get(projectId),
    before
  );
  console.log(JSON.stringify({
    ok:true,
    schemaVersion:11,
    projectDefaultTimezoneRestored:true,
    canonicalBackupRestore:true
  },null,2));
}finally{
  restored.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
