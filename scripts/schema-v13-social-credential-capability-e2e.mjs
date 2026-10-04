import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema-v13-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'schema-v13-password';
process.env.APP_MASTER_KEY = 'schema-v13-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { DATABASE_SCHEMA_VERSION } = await import('../dist/schema.js');

migrate();
try {
  assert.equal(DATABASE_SCHEMA_VERSION, 13);
  const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
  const accountId = id('acc');
  const now = nowIso();
  const encrypted = 'v1:legacy:credential:bytes';
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,credential_version,created_at,updated_at)
    VALUES (?,?,?,?,1,1,?,?)`).run(accountId, 'telegram', 'Legacy credential', encrypted, now, now);
  db.prepare('INSERT INTO project_default_targets (project_id,account_id,created_at) VALUES (?,?,?)')
    .run(project.id, accountId, now);

  const before = {
    credential: db.prepare('SELECT credentials_encrypted,enabled FROM social_accounts WHERE id=?').get(accountId),
    defaults: db.prepare('SELECT * FROM project_default_targets WHERE account_id=?').all(accountId)
  };

  db.exec('DROP TABLE social_account_capability_profiles');
  db.exec('ALTER TABLE social_accounts DROP COLUMN credential_version');
  db.pragma('user_version = 12');

  migrate();

  assert.equal(Number(db.pragma('user_version', { simple: true })), 13);
  const accountColumns = db.prepare('PRAGMA table_info(social_accounts)').all().map((row) => row.name);
  assert.ok(accountColumns.includes('credential_version'));
  const profileColumns = db.prepare('PRAGMA table_info(social_account_capability_profiles)').all().map((row) => row.name);
  for (const required of [
    'account_id','profile_schema_version','credential_version','access_level','provider_type',
    'profile_json','profile_fingerprint','last_check_status','last_check_at',
    'last_successful_checked_at','last_check_code','last_check_message','updated_at'
  ]) assert.ok(profileColumns.includes(required), required);

  const migrated = db.prepare('SELECT credentials_encrypted,enabled,credential_version FROM social_accounts WHERE id=?').get(accountId);
  assert.equal(migrated.credentials_encrypted, before.credential.credentials_encrypted);
  assert.equal(migrated.enabled, before.credential.enabled);
  assert.equal(migrated.credential_version, 1);
  assert.deepEqual(db.prepare('SELECT * FROM project_default_targets WHERE account_id=?').all(accountId), before.defaults);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM social_account_capability_profiles').get().count, 0);

  migrate();
  assert.equal(Number(db.pragma('user_version', { simple: true })), 13);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM social_account_capability_profiles').get().count, 0);

  db.pragma('user_version = 14');
  assert.throws(() => migrate(), /новее поддерживаемой 13/);
  db.pragma('user_version = 13');

  console.log(JSON.stringify({
    ok: true,
    from: 12,
    to: 13,
    credentialsPreserved: true,
    enabledPreserved: true,
    defaultTargetsPreserved: true,
    fabricatedProfiles: 0,
    rerunSafe: true,
    downgradeGuard: true
  }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
