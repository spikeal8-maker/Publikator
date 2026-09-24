import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ADMIN_PASSWORD = 'vk-saved-community-ci-password';
const APP_MASTER_KEY = 'vk-saved-community-master-key-longer-than-thirty-two-characters';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-saved-community-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = APP_MASTER_KEY;
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson, decryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');

migrate();

const accountId = id('acc');
const now = nowIso();
const originalCredentials = {
  accessToken: 'user-token',
  apiVersion: '5.199',
  destinationKind: 'PERSONAL',
  userId: '123',
  authKind: 'USER'
};
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`).run(
  accountId,
  'vk',
  'Saved VK User',
  encryptJson(originalCredentials),
  now,
  now
);

const before = db.prepare(
  'SELECT credentials_encrypted FROM social_accounts WHERE id=?'
).get(accountId);
assert.ok(before?.credentials_encrypted);

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

function vkMethod(url) {
  return /\/method\/([^/?]+)/.exec(String(url))?.[1] || null;
}

globalThis.fetch = async (input, init = {}) => {
  const method = vkMethod(input);
  assert.ok(method, `unexpected request: ${String(input)}`);
  const body = new URLSearchParams(String(init.body || ''));
  calls.push(method);

  if (method === 'users.get') {
    assert.equal(body.get('access_token'), 'user-token');
    assert.equal(body.get('v'), '5.199');
    return new Response(JSON.stringify({
      response: [{ id: 123, first_name: 'Test', last_name: 'User', screen_name: 'testuser' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (method === 'groups.getById') {
    assert.equal(body.get('access_token'), 'user-token');
    assert.equal(body.get('group_id'), '234903751');
    return new Response(JSON.stringify({
      response: {
        groups: [{ id: 234903751, name: 'IIBUSI', screen_name: 'iibusi' }],
        profiles: []
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (method === 'photos.getWallUploadServer') {
    assert.equal(body.get('access_token'), 'user-token');
    assert.equal(body.get('group_id'), '234903751');
    return new Response(JSON.stringify({
      response: { upload_url: 'https://upload.vk.test/wall-photo' }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (method === 'wall.post') {
    throw new Error('wall.post must never run during saved-account community test');
  }

  throw new Error(`unexpected VK method ${method}`);
};

try {
  const response = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/vk-community/test`,
    headers: { cookie },
    payload: { groupId: '-234903751' }
  });

  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();

  assert.equal(result.ok, true);
  assert.equal(result.platform, 'vk');
  assert.equal(result.details.authKind, 'USER');
  assert.equal(result.details.authenticatedUserId, '123');
  assert.equal(result.details.destinationKind, 'COMMUNITY');
  assert.equal(result.details.destinationId, '234903751');
  assert.equal(result.details.destinationScreenName, 'iibusi');
  assert.equal(result.details.wallPhotoReady, true);
  assert.equal(result.details.wallPostNotExecuted, true);
  assert.equal(result.destination, 'https://vk.com/iibusi');
  assert.deepEqual(calls, ['users.get', 'groups.getById', 'photos.getWallUploadServer']);
  assert.equal(calls.filter((method) => method === 'wall.post').length, 0);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('user-token'), false, 'response must not expose saved access token');
  assert.equal(serialized.includes('accessToken'), false, 'response must not expose accessToken field');

  const after = db.prepare(
    'SELECT credentials_encrypted FROM social_accounts WHERE id=?'
  ).get(accountId);
  assert.equal(after.credentials_encrypted, before.credentials_encrypted, 'endpoint must not modify stored credentials');

  const storedAfter = decryptJson(after.credentials_encrypted);
  assert.deepEqual(storedAfter, originalCredentials, 'saved PERSONAL credentials must remain unchanged');

  const count = db.prepare('SELECT COUNT(*) AS count FROM social_accounts').get();
  assert.equal(Number(count.count), 1, 'endpoint must not create a COMMUNITY account');

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'VK-SAVED-USER-COMMUNITY-TEST',
    endpoint: true,
    savedUserTokenReused: true,
    tokenExposed: false,
    groupIdNormalized: '234903751',
    resolvedScreenName: 'iibusi',
    wallPhotoReady: true,
    wallPostCalls: 0,
    accountCount: 1
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
