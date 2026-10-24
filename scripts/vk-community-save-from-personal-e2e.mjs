import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ADMIN_PASSWORD = 'vk-community-save-ci-password';
const APP_MASTER_KEY = 'vk-community-save-master-key-longer-than-thirty-two-characters';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-community-save-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = APP_MASTER_KEY;
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson, decryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');

migrate();

const sourceId = id('acc');
const now = nowIso();
const sourceCredentials = {
  accessToken: 'user-token',
  apiVersion: '5.199',
  authKind: 'USER',
  destinationKind: 'PERSONAL',
  userId: '123'
};

db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`).run(
  sourceId,
  'vk',
  'Saved Personal',
  encryptJson(sourceCredentials),
  now,
  now
);

const app = await buildApp();
await app.ready();

const login = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { password: ADMIN_PASSWORD }
});
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];

const originalFetch = globalThis.fetch;
const calls = [];
let mode = 'fail';

function vkMethod(url) {
  return /\/method\/([^/?]+)/.exec(String(url))?.[1] || null;
}

function accountCount() {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM social_accounts').get().count);
}

globalThis.fetch = async (input, init = {}) => {
  const method = vkMethod(input);
  assert.ok(method, `unexpected request: ${String(input)}`);
  calls.push(method);

  if (method === 'wall.post') {
    throw new Error('wall.post must never run during community save');
  }

  const body = new URLSearchParams(String(init.body || ''));
  assert.equal(body.get('access_token'), 'user-token');
  assert.equal(body.get('v'), '5.199');

  if (method === 'groups.getTokenPermissions') return Response.json({
    error: { error_code: 27, error_msg: 'Not supported by USER token' }
  });
  if (method === 'account.getAppPermissions') return mode === 'fail'
    ? Response.json({ error: { error_code: 5, error_msg: 'User authorization failed' } })
    : Response.json({ response: 8192 });

  if (mode === 'fail' && method === 'users.get') {
    return new Response(JSON.stringify({
      error: { error_code: 5, error_msg: 'User authorization failed' }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (method === 'users.get') {
    return new Response(JSON.stringify({
      response: [{ id: 123, first_name: 'Test', last_name: 'User', screen_name: 'testuser' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (method === 'groups.getById') {
    assert.equal(body.get('group_id'), '234903751');
    return new Response(JSON.stringify({
      response: {
        groups: [{ id: 234903751, name: 'IIBUSI', screen_name: 'iibusi' }],
        profiles: []
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (method === 'photos.getWallUploadServer') {
    assert.equal(body.get('group_id'), '234903751');
    return new Response(JSON.stringify({
      response: { upload_url: 'https://upload.vk.test/wall-photo' }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  throw new Error(`unexpected VK method ${method}`);
};

try {
  // Provider-unconfirmed yet structurally valid destination remains saved but disabled.
  const beforeFailure = accountCount();
  const failed = await app.inject({
    method: 'POST',
    url: `/api/accounts/${sourceId}/vk-community`,
    headers: { cookie },
    payload: { name: 'Unavailable COMMUNITY', groupId: '-999888777' }
  });
  assert.equal(failed.statusCode, 201, failed.body);
  assert.equal(failed.json().enabled, 0);
  assert.equal(accountCount(), beforeFailure + 1, 'unverified key is retained encrypted for recheck');
  assert.notEqual(failed.json().capabilityProfile.accessLevel, 'FULL');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_default_targets WHERE account_id=?')
    .get(failed.json().id).n, 0);

  // Success: retest the saved USER token, normalize the group, then persist one COMMUNITY account.
  mode = 'pass';
  const created = await app.inject({
    method: 'POST',
    url: `/api/accounts/${sourceId}/vk-community`,
    headers: { cookie },
    payload: { name: 'IIBUSI', groupId: '-234903751' }
  });
  assert.equal(created.statusCode, 201, created.body);
  const response = created.json();
  assert.equal(response.platform, 'vk');
  assert.equal(response.name, 'IIBUSI');
  assert.equal(response.destinationKind, 'COMMUNITY');
  assert.equal(response.destinationId, '234903751');
  assert.equal(response.destinationName, 'IIBUSI');
  assert.equal(JSON.stringify(response).includes('user-token'), false);
  assert.equal(JSON.stringify(response).includes('accessToken'), false);

  const rows = db.prepare(
    "SELECT id,name,credentials_encrypted FROM social_accounts WHERE platform='vk' ORDER BY created_at,id"
  ).all();
  assert.equal(rows.length, 3);

  const communityRow = rows.find((row) => row.id === response.id);
  assert.ok(communityRow, 'COMMUNITY account must be created');
  assert.equal(communityRow.name, 'IIBUSI');

  const saved = decryptJson(communityRow.credentials_encrypted);
  assert.equal(saved.accessToken, 'user-token');
  assert.equal(saved.apiVersion, '5.199');
  assert.equal(saved.authKind, 'USER');
  assert.equal(saved.destinationKind, 'COMMUNITY');
  assert.equal(saved.groupId, '234903751');
  assert.equal(response.destinationName, 'IIBUSI');
  assert.equal(saved.tokenGroupId, undefined, 'USER credential uses direct upload, not paired GROUP transport');
  assert.equal('userId' in saved, false);

  const sourceAfter = db.prepare(
    'SELECT credentials_encrypted FROM social_accounts WHERE id=?'
  ).get(sourceId);
  assert.deepEqual(decryptJson(sourceAfter.credentials_encrypted), sourceCredentials);

  // Duplicate: the same verified COMMUNITY groupId must not create a second account.
  const beforeDuplicate = accountCount();
  const duplicate = await app.inject({
    method: 'POST',
    url: `/api/accounts/${sourceId}/vk-community`,
    headers: { cookie },
    payload: { name: 'IIBUSI duplicate', groupId: '-234903751' }
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.equal(accountCount(), beforeDuplicate, 'duplicate COMMUNITY must not create a second account');

  assert.equal(calls.filter((method) => method === 'wall.post').length, 0);

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'VK-COMMUNITY-SAVE-FROM-PERSONAL',
    saveEndpoint: true,
    communityRetestBeforeSave: true,
    communityCreated: true,
    groupId: '234903751',
    authKind: 'USER',
    userIdRemoved: true,
    duplicateProtection: true,
    unavailableSavedDisabled: true,
    wallPostCalls: 0
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
