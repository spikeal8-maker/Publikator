import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-backup-v13-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'backup-v13-password';
process.env.APP_MASTER_KEY = 'backup-v13-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { config } = await import('../dist/config.js');
const { encryptJson, decryptJson } = await import('../dist/crypto.js');
const { saveCapabilityProfile } = await import('../dist/social-credential-capability.js');
const { createBackupBundle, resolveBackupBundle, stageRestoreBundle } = await import('../dist/backups.js');
const { applyPendingRestore } = await import('../dist/restore-bootstrap.js');

migrate();
assert.equal(Number(db.pragma('user_version', { simple: true })), 13);

const accountId = id('acc');
const now = nowIso();
const secretValue = 'backup-v13-secret-value';
const encrypted = encryptJson({ botToken: secretValue, chatId: '-1001234567890' });
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,credential_version,created_at,updated_at)
  VALUES (?,?,?,?,1,1,?,?)`).run(accountId, 'telegram', 'Backup credential', encrypted, now, now);

const profile = saveCapabilityProfile(accountId, {
  inspectionCompleted: true,
  providerType: 'BOT',
  credential: {
    validity: 'CONFIRMED',
    identity: '@backup_bot',
    ownerId: '123',
    declaredPermissions: ['post']
  },
  destination: {
    resolutionState: 'CONFIRMED',
    kind: 'CHANNEL',
    id: '-1001234567890',
    name: 'Backup Channel',
    role: 'administrator',
    ownershipConfirmed: false
  },
  methods: [
    { method: 'getMe', state: 'CONFIRMED', evidenceSource: 'telegram', reason: 'ok' },
    { method: 'getChatMember', state: 'CONFIRMED', evidenceSource: 'telegram', reason: 'ok' }
  ],
  publicationEvidence: {
    IMAGE: { state: 'CONFIRMED', requiredMethods: ['sendPhoto'] },
    CAROUSEL: { state: 'CONFIRMED', requiredMethods: ['sendMediaGroup'] }
  },
  adapterCapability: { IMAGE: true, CAROUSEL: true },
  remediation: [],
  warnings: [],
  lastCheckCode: 'OK',
  lastCheckMessage: 'Provider check succeeded'
});
assert.equal(profile.profileCurrent, true);
assert.equal(profile.accessLevel, 'FULL');

const beforeAccount = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(accountId);
const beforeProfile = db.prepare('SELECT * FROM social_account_capability_profiles WHERE account_id=?').get(accountId);
assert.ok(beforeProfile);
assert.equal(String(beforeProfile.profile_json).includes(secretValue), false);

const bundle = await createBackupBundle('schema13-social-credential-capability');
const bundlePath = resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size > 0);

db.prepare('DELETE FROM social_account_capability_profiles WHERE account_id=?').run(accountId);
db.prepare('UPDATE social_accounts SET credentials_encrypted=?,credential_version=99 WHERE id=?')
  .run(encryptJson({ botToken: 'mutated-secret', chatId: 'mutated' }), accountId);

const staged = await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion, 13);
db.close();

const applied = await applyPendingRestore();
assert.equal(applied.applied, true);

const restored = new Database(config.dbPath, { readonly: true, fileMustExist: true });
try {
  assert.equal(Number(restored.pragma('user_version', { simple: true })), 13);
  const account = restored.prepare('SELECT * FROM social_accounts WHERE id=?').get(accountId);
  const capability = restored.prepare('SELECT * FROM social_account_capability_profiles WHERE account_id=?').get(accountId);
  assert.deepEqual(account, beforeAccount);
  assert.deepEqual(capability, beforeProfile);
  assert.deepEqual(decryptJson(account.credentials_encrypted), { botToken: secretValue, chatId: '-1001234567890' });
  assert.equal(String(capability.profile_json).includes(secretValue), false);
  assert.equal(String(capability.last_check_message || '').includes(secretValue), false);

  console.log(JSON.stringify({
    ok: true,
    schemaVersion: 13,
    capabilityProfileRestored: true,
    encryptedCredentialsDecryptable: true,
    secretAbsentFromSafeProfile: true,
    canonicalBackupRestore: true
  }, null, 2));
} finally {
  restored.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
