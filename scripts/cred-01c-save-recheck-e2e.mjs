import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cred-01c-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cred-01c-password';
process.env.APP_MASTER_KEY = 'cred-01c-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';
process.env.EVENT_RETENTION_DAYS = '0';
process.env.BACKUP_RETENTION_COUNT = '0';

const { db, migrate } = await import('../dist/db.js');
const { decryptJson } = await import('../dist/crypto.js');
const {
  setSocialCredentialInspectorForTests
} = await import('../dist/social-account-credentials.js');

migrate();

const callCounts = new Map();
const seenCredentials = [];

function nextMode(token) {
  const count = (callCounts.get(token) || 0) + 1;
  callCounts.set(token, count);
  if (token === 'transient-secret') return count === 1 ? 'FULL' : 'UNAVAILABLE';
  if (token === 'gain-secret') return count === 1 ? 'SETUP_REQUIRED' : 'FULL';
  if (token === 'partial-secret') return 'PARTIAL';
  if (token === 'setup-secret') return 'SETUP_REQUIRED';
  if (token === 'invalid-secret') return 'INVALID';
  if (token === 'unavailable-secret') return 'UNAVAILABLE';
  return 'FULL';
}

function inspection(mode, credentials) {
  const chatId = String(credentials.chatId);
  const base = {
    platform: 'telegram',
    credential: {
      validity: 'CONFIRMED',
      providerType: 'BOT',
      identity: '@cred01c_bot',
      ownerId: '42',
      expiresAt: null,
      declaredPermissions: ['can_post_messages'],
      permissionsSource: 'getChatMember'
    },
    destination: {
      resolutionState: 'CONFIRMED',
      kind: 'CHANNEL',
      id: chatId,
      name: 'CRED-01C test channel',
      role: 'administrator',
      ownershipConfirmed: null
    },
    methods: [{
      method: 'telegram.getChatMember',
      state: 'CONFIRMED',
      evidenceSource: 'telegram',
      machineCode: 'STATUS_ADMINISTRATOR',
      reason: 'Structured inspection evidence.'
    }],
    publicationEvidence: {
      IMAGE: { state: 'CONFIRMED', requiredMethods: ['sendPhoto'] },
      CAROUSEL: { state: 'CONFIRMED', requiredMethods: ['sendMediaGroup'] }
    },
    runtimePrerequisiteEvidence: [],
    remediation: [],
    warnings: []
  };

  if (mode === 'PARTIAL') {
    base.publicationEvidence = {
      IMAGE: { state: 'CONFIRMED', requiredMethods: ['sendPhoto'] },
      CAROUSEL: { state: 'DENIED', requiredMethods: ['sendMediaGroup'] }
    };
    return base;
  }

  if (mode === 'SETUP_REQUIRED') {
    base.methods = [{
      method: 'telegram.can_post_messages',
      state: 'DENIED',
      evidenceSource: 'telegram',
      machineCode: 'FALSE',
      reason: 'Bot needs publication rights.'
    }];
    base.publicationEvidence = {
      IMAGE: { state: 'SETUP_REQUIRED', remediationCodes: ['TELEGRAM_CAN_POST_MESSAGES_REQUIRED'] },
      CAROUSEL: { state: 'SETUP_REQUIRED', remediationCodes: ['TELEGRAM_CAN_POST_MESSAGES_REQUIRED'] }
    };
    base.remediation = [{
      code: 'TELEGRAM_CAN_POST_MESSAGES_REQUIRED',
      title: 'Нужно право публикации',
      explanation: 'Выдайте боту право публикации.',
      requiredCredentialType: null,
      requiredPermissions: ['can_post_messages'],
      steps: ['Откройте настройки канала и выдайте право публикации.'],
      primaryAction: null,
      secondaryActions: []
    }];
    return base;
  }

  if (mode === 'INVALID') {
    base.credential = {
      ...base.credential,
      validity: 'INVALID',
      identity: null,
      ownerId: null,
      declaredPermissions: [],
      permissionsSource: null
    };
    base.destination = {
      resolutionState: 'UNKNOWN',
      kind: null,
      id: null,
      name: null,
      role: null,
      ownershipConfirmed: null
    };
    base.methods = [{
      method: 'telegram.getMe',
      state: 'DENIED',
      evidenceSource: 'telegram',
      machineCode: 'TELEGRAM_401',
      reason: 'Provider rejected credential.'
    }];
    base.publicationEvidence = {};
    return base;
  }

  if (mode === 'UNAVAILABLE') {
    base.credential = {
      ...base.credential,
      validity: 'UNAVAILABLE',
      identity: null,
      ownerId: null,
      declaredPermissions: [],
      permissionsSource: null
    };
    base.destination = {
      resolutionState: 'UNAVAILABLE',
      kind: null,
      id: null,
      name: null,
      role: null,
      ownershipConfirmed: null
    };
    base.methods = [{
      method: 'telegram.getMe',
      state: 'UNAVAILABLE',
      evidenceSource: 'telegram',
      machineCode: 'NETWORK_TIMEOUT',
      reason: 'Provider temporarily unavailable.'
    }];
    base.publicationEvidence = {
      IMAGE: { state: 'UNAVAILABLE', remediationCodes: ['NETWORK_TIMEOUT'] },
      CAROUSEL: { state: 'UNAVAILABLE', remediationCodes: ['NETWORK_TIMEOUT'] }
    };
    return base;
  }

  return base;
}

setSocialCredentialInspectorForTests(async (platform, credentials) => {
  assert.equal(platform, 'telegram');
  const snapshot = structuredClone(credentials);
  seenCredentials.push(snapshot);
  const token = String(credentials.botToken || '');
  return inspection(nextMode(token), credentials);
});

const { buildApp } = await import('../dist/app.js');
const app = await buildApp();
const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
let cookie = '';

async function request(route, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('cookie', cookie);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${baseUrl}${route}`, { ...options, headers });
}

async function json(route, options = {}, expectedStatus = 200) {
  const response = await request(route, options);
  const payload = await response.json().catch(() => ({}));
  assert.equal(
    response.status,
    expectedStatus,
    `${options.method || 'GET'} ${route}: ${JSON.stringify(payload)}`
  );
  return payload;
}

function accountDb(accountId) {
  return db.prepare(`SELECT id,platform,name,credentials_encrypted,enabled,credential_version
    FROM social_accounts WHERE id=?`).get(accountId);
}

function defaultTargetCount(projectId, accountId) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM project_default_targets
    WHERE project_id=? AND account_id=?`).get(projectId, accountId).count);
}

async function saveTelegram(token, suffix, extraCredentials = {}) {
  return json('/api/accounts/save-and-check', {
    method: 'POST',
    body: JSON.stringify({
      platform: 'telegram',
      name: `Telegram ${suffix}`,
      credentials: {
        botToken: token,
        chatId: `-100${suffix}`,
        ...extraCredentials
      }
    })
  }, 201);
}

try {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'cred-01c-password' })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie?.startsWith('publikator_session='));
  cookie = setCookie.split(';')[0];

  const project = await json('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'CRED-01C Project', slug: 'cred-01c-project' })
  }, 201);

  const accountCountBeforeInvalidLocal = Number(
    db.prepare('SELECT COUNT(*) AS count FROM social_accounts').get().count
  );
  await json('/api/accounts/save-and-check', {
    method: 'POST',
    body: JSON.stringify({
      platform: 'telegram',
      name: 'Missing secret',
      credentials: { botToken: '', chatId: '-1000' }
    })
  }, 400);
  assert.equal(
    Number(db.prepare('SELECT COUNT(*) AS count FROM social_accounts').get().count),
    accountCountBeforeInvalidLocal,
    'local-invalid request must not persist an account'
  );

  const full = await saveTelegram('full-secret', '101', {
    authKind: 'USER',
    publishReady: true,
    providerType: 'FORGED',
    permissions: ['everything'],
    accessLevel: 'FULL',
    methods: [{ state: 'READY' }]
  });
  assert.equal(full.capabilityProfile.accessLevel, 'FULL');
  assert.equal(full.capabilityProfile.providerType, 'BOT');
  assert.equal(full.capabilityProfile.profileCurrent, true);
  assert.equal(full.account.enabled, true);
  assert.equal(full.account.credentialVersion, 1);
  assert.equal(defaultTargetCount(project.id, full.account.id), 1);
  const fullRow = accountDb(full.account.id);
  assert.equal(fullRow.enabled, 1);
  assert.equal(fullRow.credential_version, 1);
  assert.equal(String(fullRow.credentials_encrypted).includes('full-secret'), false);
  assert.deepEqual(
    decryptJson(fullRow.credentials_encrypted),
    { botToken: 'full-secret', chatId: '-100101' }
  );
  assert.deepEqual(
    Object.keys(seenCredentials[0]).sort(),
    ['botToken', 'chatId'],
    'browser capability assertions must be discarded before inspection'
  );

  const partial = await saveTelegram('partial-secret', '102');
  assert.equal(partial.capabilityProfile.accessLevel, 'PARTIAL');
  assert.equal(partial.capabilityProfile.semantic.publicationReadiness.IMAGE.state, 'READY');
  assert.notEqual(partial.capabilityProfile.semantic.publicationReadiness.CAROUSEL.state, 'READY');
  assert.equal(partial.account.enabled, true);
  assert.equal(defaultTargetCount(project.id, partial.account.id), 1);

  const setup = await saveTelegram('setup-secret', '103');
  assert.equal(setup.capabilityProfile.accessLevel, 'SETUP_REQUIRED');
  assert.equal(setup.account.enabled, false);
  assert.equal(defaultTargetCount(project.id, setup.account.id), 0);
  assert.ok(accountDb(setup.account.id));

  const invalid = await saveTelegram('invalid-secret', '104');
  assert.equal(invalid.capabilityProfile.accessLevel, 'INVALID');
  assert.equal(invalid.capabilityProfile.lastCheckStatus, 'INVALID');
  assert.equal(invalid.account.enabled, false);
  assert.equal(defaultTargetCount(project.id, invalid.account.id), 0);
  assert.ok(accountDb(invalid.account.id));

  const unavailable = await saveTelegram('unavailable-secret', '105');
  assert.equal(unavailable.capabilityProfile.accessLevel, 'UNAVAILABLE');
  assert.equal(unavailable.capabilityProfile.lastCheckStatus, 'UNAVAILABLE');
  assert.equal(unavailable.account.enabled, false);
  assert.equal(defaultTargetCount(project.id, unavailable.account.id), 0);
  assert.ok(accountDb(unavailable.account.id));

  const seenBeforeStoredRecheck = seenCredentials.length;
  const recheckedFull = await json(`/api/accounts/${full.account.id}/recheck`, {
    method: 'POST'
  });
  assert.equal(recheckedFull.capabilityProfile.accessLevel, 'FULL');
  assert.equal(recheckedFull.account.enabled, true);
  assert.equal(seenCredentials.length, seenBeforeStoredRecheck + 1);
  assert.equal(seenCredentials.at(-1).botToken, 'full-secret');
  assert.deepEqual(Object.keys(seenCredentials.at(-1)).sort(), ['botToken', 'chatId']);

  const transient = await saveTelegram('transient-secret', '106');
  assert.equal(transient.capabilityProfile.accessLevel, 'FULL');
  const transientFingerprint = transient.capabilityProfile.profileFingerprint;
  const transientSemantic = transient.capabilityProfile.semantic;
  const transientLastSuccess = transient.capabilityProfile.lastSuccessfulCheckedAt;
  const transientRecheck = await json(`/api/accounts/${transient.account.id}/recheck`, {
    method: 'POST'
  });
  assert.equal(transientRecheck.capabilityProfile.accessLevel, 'FULL');
  assert.equal(transientRecheck.capabilityProfile.lastCheckStatus, 'UNAVAILABLE');
  assert.equal(transientRecheck.capabilityProfile.profileFingerprint, transientFingerprint);
  assert.deepEqual(transientRecheck.capabilityProfile.semantic, transientSemantic);
  assert.equal(transientRecheck.capabilityProfile.lastSuccessfulCheckedAt, transientLastSuccess);
  assert.equal(transientRecheck.account.enabled, true);

  const gain = await saveTelegram('gain-secret', '107');
  assert.equal(gain.capabilityProfile.accessLevel, 'SETUP_REQUIRED');
  assert.equal(gain.account.enabled, false);
  assert.equal(defaultTargetCount(project.id, gain.account.id), 0);
  const gainRecheck = await json(`/api/accounts/${gain.account.id}/recheck`, {
    method: 'POST'
  });
  assert.equal(gainRecheck.capabilityProfile.accessLevel, 'FULL');
  assert.equal(gainRecheck.account.enabled, false, 'recheck must preserve operator enabled state');
  assert.equal(defaultTargetCount(project.id, gain.account.id), 0, 'later recheck must not silently add project defaults');

  const serialized = JSON.stringify({
    full,
    partial,
    setup,
    invalid,
    unavailable,
    recheckedFull,
    transient,
    transientRecheck,
    gain,
    gainRecheck
  });
  for (const secret of [
    'full-secret',
    'partial-secret',
    'setup-secret',
    'invalid-secret',
    'unavailable-secret',
    'transient-secret',
    'gain-secret'
  ]) {
    assert.equal(serialized.includes(secret), false, `response leaked secret ${secret}`);
  }
  assert.equal(serialized.includes('credentials_encrypted'), false);
  assert.equal(serialized.includes('"botToken"'), false);
  assert.equal(serialized.includes('"accessToken"'), false);

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'CRED-01C-S1',
    saveAndCheck: true,
    recheck: true,
    full: true,
    partial: true,
    setupRequired: true,
    invalidPersisted: true,
    unavailablePersisted: true,
    transientRecheckPreservesProfile: true,
    noBrowserSecretRecheck: true,
    clientAssertionsIgnored: true,
    projectDefaults: true,
    recheckDoesNotAutoEnableOrAddDefaults: true,
    secretSafety: true
  }, null, 2));
} finally {
  setSocialCredentialInspectorForTests(null);
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
