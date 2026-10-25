import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-backup14-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = 'admin-backup14-master-key-with-more-than-32-characters';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8080';

const {db,migrate,id,nowIso} = await import('../dist/db.js');
const {config} = await import('../dist/config.js');
const {DATABASE_SCHEMA_VERSION} = await import('../dist/schema.js');
const {encryptJson,decryptJson} = await import('../dist/crypto.js');
const {createAdminSetupGrant,createOrRecoverAdmin,sessionAdmin} = await import('../dist/admin-auth.js');
const {createBackupBundle,resolveBackupBundle,stageRestoreBundle} = await import('../dist/backups.js');
const {applyPendingRestore} = await import('../dist/restore-bootstrap.js');

migrate();
const grant = createAdminSetupGrant('INITIAL');
const session = createOrRecoverAdmin('INITIAL',grant,'admin_owner','long-password-for-owner-2026','long-password-for-owner-2026');
assert.equal(sessionAdmin(session)?.username, 'admin_owner');

const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const accountId = id('acc'), postId = id('post'), timestamp = nowIso();
const telegram = {botToken:'preserve-telegram-secret',chatId:'@Alikin_SA'};
const vk = {accessToken:'preserve-vk-secret',groupId:'12345',authKind:'COMMUNITY',textPublishReady:true};
for(const [platform,name,credentials] of [['telegram','Telegram Channel',telegram],['vk','VK Group',vk]]) {
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`).run(platform==='telegram'?accountId:id('acc'),platform,name,encryptJson(credentials),timestamp,timestamp);
}
db.prepare(`INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at)
  VALUES (?,?,?,?,'READY','APPROVED','MANUAL',?,?)`)
  .run(postId,projectId,'Preserved READY post','No public posting',timestamp,timestamp);
db.prepare(`INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at)
  VALUES (?,?,?,1,'PENDING',0,?)`).run(id('target'),postId,accountId,timestamp);
const before = {
  user:db.prepare('SELECT * FROM admin_users').get(),
  session:db.prepare('SELECT * FROM admin_sessions').get(),
  accounts:db.prepare('SELECT * FROM social_accounts ORDER BY platform').all(),
  post:db.prepare('SELECT * FROM posts WHERE id=?').get(postId),
  target:db.prepare('SELECT * FROM post_targets WHERE post_id=?').get(postId)
};
const backup = await createBackupBundle('admin-schema14-real-content');
await fs.stat(resolveBackupBundle(backup.name));
db.prepare('DELETE FROM admin_sessions').run();
db.prepare('DELETE FROM admin_users').run();
db.prepare("UPDATE posts SET status='DRAFT' WHERE id=?").run(postId);
db.prepare('DELETE FROM social_accounts WHERE platform=?').run('vk'); // Unrelated social account
const stage = await stageRestoreBundle(resolveBackupBundle(backup.name));
assert.ok(DATABASE_SCHEMA_VERSION >= 14);
assert.equal(stage.manifest.schemaVersion,DATABASE_SCHEMA_VERSION);
db.close();
const result = await applyPendingRestore();
assert.equal(result.applied,true);
const restored = new Database(config.dbPath,{readonly:true,fileMustExist:true});
try {
  assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(Number(restored.pragma('user_version',{simple:true})),DATABASE_SCHEMA_VERSION);
  assert.deepEqual(restored.prepare('SELECT * FROM admin_users').get(),before.user);
  assert.deepEqual(restored.prepare('SELECT * FROM admin_sessions').get(),before.session);
  assert.deepEqual(restored.prepare('SELECT * FROM social_accounts ORDER BY platform').all(),before.accounts);
  assert.deepEqual(restored.prepare('SELECT * FROM posts WHERE id=?').get(postId),before.post);
  assert.deepEqual(restored.prepare('SELECT * FROM post_targets WHERE post_id=?').get(postId),before.target);
  for(const account of before.accounts) {
    const secret=decryptJson(account.credentials_encrypted);
    assert.deepEqual(secret,account.platform==='telegram'?telegram:vk);
  }
  assert.equal(restored.prepare('SELECT COUNT(*) as n FROM admin_users').get().n,1);
  console.log(JSON.stringify({ok:true,schema:DATABASE_SCHEMA_VERSION,checkpoint:'schema14-admin-auth',accountsPreserved:true,readyPostPreserved:true,encryptedSecretsDecryptable:true,adminSessionRestored:true}));
} finally {
  restored.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
