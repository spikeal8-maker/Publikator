import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema14-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = 'admin-schema14-master-key-with-more-than-32-characters';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8080';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { DATABASE_SCHEMA_VERSION } = await import('../dist/schema.js');
const { encryptJson, decryptJson } = await import('../dist/crypto.js');
migrate();
try {
  assert.equal(DATABASE_SCHEMA_VERSION, 14);
  const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
  const timestamp = nowIso();
  const account = id('acc');
  const post = id('post');
  const credential = encryptJson({ botToken: 'preserved-token', chatId: '@Alikin_SA' });
  db.prepare(`INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`).run(account, 'telegram', 'Existing Telegram', credential, timestamp, timestamp);
  db.prepare(`INSERT INTO posts(id,project_id,title,body,status,editorial_stage,schedule_mode,created_at,updated_at)
    VALUES (?,?,?,?,'READY','APPROVED','MANUAL',?,?)`)
    .run(post, project.id, 'Existing READY post', 'Publication text', timestamp, timestamp);
  db.prepare(`INSERT INTO post_targets(id,post_id,account_id,enabled,state,attempts,updated_at)
    VALUES (?,?,?,1,'PENDING',0,?)`).run(id('target'), post, account, timestamp);
  const before = {
    projects: db.prepare('SELECT * FROM projects').all(),
    accounts: db.prepare('SELECT * FROM social_accounts').all(),
    posts: db.prepare('SELECT * FROM posts').all(),
    targets: db.prepare('SELECT * FROM post_targets').all()
  };
  db.exec('DROP TABLE admin_sessions; DROP TABLE admin_setup_grants; DROP TABLE admin_users; DROP TABLE admin_legacy_session_revocations;');
  db.pragma('user_version = 13');
  migrate();
  assert.equal(Number(db.pragma('user_version', { simple:true })), 14);
  for (const table of ['admin_users','admin_sessions','admin_setup_grants','admin_legacy_session_revocations']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.deepEqual(db.prepare('SELECT * FROM projects').all(), before.projects);
  assert.deepEqual(db.prepare('SELECT * FROM social_accounts').all(), before.accounts);
  assert.deepEqual(db.prepare('SELECT * FROM posts').all(), before.posts);
  assert.deepEqual(db.prepare('SELECT * FROM post_targets').all(), before.targets);
  assert.deepEqual(decryptJson(credential), { botToken: 'preserved-token', chatId: '@Alikin_SA' });
  migrate();
  assert.equal(Number(db.pragma('user_version', {simple:true})), 14);
  db.pragma('user_version = 15');
  assert.throws(() => migrate(), /новее поддерживаемой 14/);
  db.pragma('user_version = 14');
  console.log(JSON.stringify({ok:true,from:13,to:14,readyPreserved:true,encryptedCredentialsPreserved:true,rerunSafe:true,downgradeGuard:true}));
} finally {
  db.close();
  await fs.rm(dataDir, {recursive:true,force:true});
}
