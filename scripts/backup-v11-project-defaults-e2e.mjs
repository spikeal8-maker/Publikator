import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION } from './current-schema-version.mjs';

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
assert.equal(Number(db.pragma('user_version',{simple:true})),CURRENT_SCHEMA_VERSION);

const projectId=id('prj');
const accountId=id('acc');
const createdAt=nowIso();
db.prepare('INSERT INTO projects(id,name,slug,default_timezone,default_targets_explicit,created_at) VALUES (?,?,?,?,?,?)')
  .run(projectId,'Backup v11 project','backup-v11-project','Asia/Tokyo',1,createdAt);
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`)
  .run(accountId,'telegram','Backup default target','encrypted',createdAt,createdAt);
db.prepare('INSERT INTO project_default_targets(project_id,account_id,created_at) VALUES (?,?,?)')
  .run(projectId,accountId,createdAt);

const before=db.prepare('SELECT id,name,slug,default_timezone,default_targets_explicit,created_at FROM projects WHERE id=?').get(projectId);
const defaultsBefore=db.prepare(`SELECT project_id,account_id,created_at FROM project_default_targets
  WHERE project_id=? ORDER BY account_id`).all(projectId);
const bundle=await createBackupBundle('schema11-project-defaults');
const bundlePath=resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size>0);

db.prepare('UPDATE projects SET default_timezone=?,default_targets_explicit=0 WHERE id=?').run('UTC',projectId);
db.prepare('DELETE FROM project_default_targets WHERE project_id=?').run(projectId);

const staged=await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion,CURRENT_SCHEMA_VERSION);
db.close();

const applied=await applyPendingRestore();
assert.equal(applied.applied,true);

const restored=new Database(config.dbPath,{readonly:true,fileMustExist:true});
try{
  assert.equal(Number(restored.pragma('user_version',{simple:true})),CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    restored.prepare('SELECT id,name,slug,default_timezone,default_targets_explicit,created_at FROM projects WHERE id=?').get(projectId),
    before
  );
  assert.deepEqual(
    restored.prepare(`SELECT project_id,account_id,created_at FROM project_default_targets
      WHERE project_id=? ORDER BY account_id`).all(projectId),
    defaultsBefore
  );
  console.log(JSON.stringify({
    ok:true,
    schemaVersion:CURRENT_SCHEMA_VERSION,
    projectDefaultTimezoneRestored:true,
    projectDefaultTargetsExplicitRestored:true,
    projectDefaultTargetsRestored:true,
    canonicalBackupRestore:true
  },null,2));
}finally{
  restored.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
