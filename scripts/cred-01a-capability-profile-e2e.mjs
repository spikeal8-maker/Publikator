import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cred-01a-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cred-01a-password';
process.env.APP_MASTER_KEY = 'cred-01a-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const {
  buildCapabilityProfile,
  capabilityFingerprint,
  classifyAccessLevel,
  readCapabilityProfile,
  replaceSocialAccountCredentials,
  saveCapabilityProfile
} = await import('../dist/social-credential-capability.js');

migrate();
try {
  assert.equal(Number(db.pragma('user_version', { simple: true })), 13);

  const accountId = id('acc');
  const now = nowIso();
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,credential_version,created_at,updated_at)
    VALUES (?,?,?,?,1,1,?,?)`).run(
      accountId,
      'vk',
      'Credential profile test',
      encryptJson({ accessToken: 'real-secret-not-for-profile', groupId: '1' }),
      now,
      now
    );

  const allFormats = {
    TEXT: false,
    IMAGE: true,
    CAROUSEL: true,
    VIDEO: false,
    SHORT: false,
    STORY: false
  };

  const fullInput = {
    inspectionCompleted: true,
    providerType: 'USER',
    credential: {
      validity: 'CONFIRMED',
      identity: 'Display Name A',
      ownerId: 'vk-user-1',
      declaredPermissions: ['wall', 'photos', 'wall'],
      permissionsSource: 'account.getAppPermissions',
      accessToken: 'nested-secret-must-be-ignored'
    },
    destination: {
      resolutionState: 'CONFIRMED',
      kind: 'COMMUNITY',
      id: '123',
      name: 'School A',
      role: 'publisher',
      ownershipConfirmed: true
    },
    methods: [
      { method: 'wall.post', state: 'NOT_CHECKED', evidenceSource: 'vk', reason: 'public call is not used' },
      { method: 'photos.getWallUploadServer', state: 'CONFIRMED', evidenceSource: 'vk', reason: 'access_token=fake-secret-value' }
    ],
    publicationEvidence: {
      IMAGE: { state: 'CONFIRMED', requiredMethods: ['photos.saveWallPhoto', 'photos.getWallUploadServer'] },
      CAROUSEL: { state: 'CONFIRMED', requiredMethods: ['photos.getWallUploadServer', 'photos.saveWallPhoto'] }
    },
    runtimePrerequisites: [],
    remediation: [{
      code: 'UNUSED_EXAMPLE',
      title: 'Help title',
      explanation: 'Bearer fake-secret-value',
      requiredPermissions: ['photos'],
      steps: ['Open https://example.test/?access_token=fake-secret-value'],
      primaryAction: { label: 'Help', kind: 'OFFICIAL_HELP_URL', target: 'https://example.test/?token=fake-secret-value' },
      secondaryActions: []
    }],
    warnings: ['https://example.test/?access_token=fake-secret-value'],
    adapterCapability: allFormats
  };

  const built = buildCapabilityProfile(fullInput);
  assert.equal(built.accessLevel, 'FULL');
  assert.equal(built.verdict, 'FULL');
  assert.deepEqual(built.semantic.credential.declaredPermissions, ['photos', 'wall']);
  assert.equal(JSON.stringify(built.semantic).includes('fake-secret-value'), false);

  const partial = buildCapabilityProfile({
    ...fullInput,
    publicationEvidence: {
      IMAGE: { state: 'CONFIRMED', requiredMethods: ['photos.getWallUploadServer'] },
      CAROUSEL: { state: 'DENIED', requiredMethods: ['photos.saveWallPhoto'] }
    }
  });
  assert.equal(partial.accessLevel, 'PARTIAL');

  const setup = buildCapabilityProfile({
    ...fullInput,
    publicationEvidence: {
      IMAGE: { state: 'DENIED', remediationCodes: ['VK_IMAGE_REQUIRES_USER'] },
      CAROUSEL: { state: 'DENIED', remediationCodes: ['VK_IMAGE_REQUIRES_USER'] }
    }
  });
  assert.equal(setup.accessLevel, 'SETUP_REQUIRED');

  const readOnly = buildCapabilityProfile({
    ...fullInput,
    publicationEvidence: {
      IMAGE: { state: 'DENIED' },
      CAROUSEL: { state: 'DENIED' }
    }
  });
  assert.equal(readOnly.accessLevel, 'READ_ONLY');

  const invalid = buildCapabilityProfile({
    ...fullInput,
    credential: { ...fullInput.credential, validity: 'INVALID' }
  });
  assert.equal(invalid.accessLevel, 'INVALID');

  const unavailable = buildCapabilityProfile({
    ...fullInput,
    credential: { ...fullInput.credential, validity: 'UNAVAILABLE' }
  });
  assert.equal(unavailable.accessLevel, 'UNAVAILABLE');

  const onlyNotImplemented = classifyAccessLevel(
    true,
    'CONFIRMED',
    {
      TEXT: { state: 'NOT_IMPLEMENTED', reason: '', requiredMethods: [], remediationCodes: [] },
      IMAGE: { state: 'READY', reason: '', requiredMethods: [], remediationCodes: [] },
      CAROUSEL: { state: 'NOT_IMPLEMENTED', reason: '', requiredMethods: [], remediationCodes: [] },
      VIDEO: { state: 'NOT_IMPLEMENTED', reason: '', requiredMethods: [], remediationCodes: [] },
      SHORT: { state: 'NOT_IMPLEMENTED', reason: '', requiredMethods: [], remediationCodes: [] },
      STORY: { state: 'NOT_IMPLEMENTED', reason: '', requiredMethods: [], remediationCodes: [] }
    },
    { IMAGE: true }
  );
  assert.equal(onlyNotImplemented, 'FULL');

  const saved = saveCapabilityProfile(accountId, {
    ...fullInput,
    lastCheckCode: 'OK',
    lastCheckMessage: 'token=fake-secret-value https://example.test/?access_token=fake-secret-value https://api.telegram.org/bot123456789:fake-secret-value/getMe'
  });
  assert.equal(saved.profileCurrent, true);
  assert.equal(saved.accessLevel, 'FULL');
  assert.equal(saved.lastCheckMessage.includes('fake-secret-value'), false);
  const row = db.prepare('SELECT * FROM social_account_capability_profiles WHERE account_id=?').get(accountId);
  assert.equal(String(row.profile_json).includes('fake-secret-value'), false);
  assert.equal(String(row.profile_json).includes('"accessLevel"'), false);
  assert.equal(String(row.profile_json).includes('"providerType"'), false);
  assert.equal(String(row.profile_json).includes('"credentialVersion"'), false);

  const reordered = buildCapabilityProfile({
    ...fullInput,
    credential: { ...fullInput.credential, identity: 'Renamed Display', declaredPermissions: ['photos', 'wall'] },
    methods: [...fullInput.methods].reverse(),
    publicationEvidence: {
      IMAGE: { state: 'CONFIRMED', requiredMethods: ['photos.getWallUploadServer', 'photos.saveWallPhoto'] },
      CAROUSEL: { state: 'CONFIRMED', requiredMethods: ['photos.saveWallPhoto', 'photos.getWallUploadServer'] }
    },
    warnings: ['different warning'],
    remediation: [{
      code: 'UNUSED_EXAMPLE',
      title: 'Different human title',
      explanation: 'Different prose',
      requiredPermissions: ['photos'],
      steps: ['Different prose'],
      primaryAction: null,
      secondaryActions: []
    }]
  });
  assert.equal(capabilityFingerprint(1, built), capabilityFingerprint(1, reordered));

  const permissionChanged = buildCapabilityProfile({
    ...fullInput,
    credential: { ...fullInput.credential, declaredPermissions: ['wall'] }
  });
  assert.notEqual(capabilityFingerprint(1, built), capabilityFingerprint(1, permissionChanged));

  const destinationChanged = buildCapabilityProfile({
    ...fullInput,
    destination: { ...fullInput.destination, id: '456' }
  });
  assert.notEqual(capabilityFingerprint(1, built), capabilityFingerprint(1, destinationChanged));
  assert.notEqual(capabilityFingerprint(1, built), capabilityFingerprint(2, built));

  db.prepare('UPDATE social_accounts SET credential_version=2 WHERE id=?').run(accountId);
  const stale = readCapabilityProfile(accountId);
  assert.equal(stale.profileCurrent, false);
  assert.equal(stale.accessLevel, 'UNCHECKED');

  db.prepare('UPDATE social_accounts SET credential_version=1 WHERE id=?').run(accountId);
  db.prepare('UPDATE social_account_capability_profiles SET profile_schema_version=99 WHERE account_id=?').run(accountId);
  const oldVersion = readCapabilityProfile(accountId);
  assert.equal(oldVersion.profileCurrent, false);
  assert.equal(oldVersion.accessLevel, 'UNCHECKED');

  saveCapabilityProfile(accountId, fullInput);
  db.prepare("UPDATE social_account_capability_profiles SET access_level='PARTIAL' WHERE account_id=?").run(accountId);
  const divergent = readCapabilityProfile(accountId);
  assert.equal(divergent.profileCurrent, false);
  assert.equal(divergent.accessLevel, 'UNCHECKED');

  saveCapabilityProfile(accountId, fullInput);
  const nextVersion = replaceSocialAccountCredentials(
    accountId,
    encryptJson({ accessToken: 'replacement-secret', groupId: '2' })
  );
  assert.equal(nextVersion, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM social_account_capability_profiles WHERE account_id=?').get(accountId).count, 0);
  assert.equal(readCapabilityProfile(accountId).accessLevel, 'UNCHECKED');

  console.log(JSON.stringify({
    ok: true,
    schemaVersion: 13,
    classifier: true,
    readinessBuilder: true,
    canonicalWrite: true,
    deterministicFingerprint: true,
    staleProfileRejected: true,
    unsupportedProfileVersionRejected: true,
    secretSafety: true,
    credentialMutationInvalidation: true
  }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
