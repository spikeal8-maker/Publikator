import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-key-diag-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'vk-key-diag-password';
process.env.APP_MASTER_KEY = 'vk-key-diag-master-key-longer-than-thirty-two-characters';

const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
const { vkCommunityTokenNotice } = await import('../public/social-credentials.js');
migrate();
const app = await buildApp();
await app.ready();

const originalFetch = globalThis.fetch;
const calls = [];
function vkResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' }
  });
}
function vkError(code, message) {
  return vkResponse({ error: { error_code: code, error_msg: message } });
}

globalThis.fetch = async (input, init = {}) => {
  const method = /\/method\/([^/?]+)/.exec(String(input))?.[1];
  assert.ok(method, `unexpected request ${String(input)}`);
  const body = new URLSearchParams(String(init.body || ''));
  const token = body.get('access_token');
  calls.push(method);
  if (token === 'valid-group-token') {
    assert.equal(method, 'groups.getTokenPermissions');
    return vkResponse({ response: {
      mask: 8196, permissions: [
        { name: 'photos', setting: 4 }, { name: 'wall', setting: 8192 }
      ]
    } });
  }
  if (token === 'invalid-token') return vkError(5, 'User authorization failed');
  if (token === 'outage-token') {
    if (method === 'groups.getTokenPermissions') return vkResponse({ error: 'outage' }, 503);
    return vkError(5, 'User authorization failed');
  }
  if (token === 'valid-user-token') {
    if (method === 'groups.getTokenPermissions') return vkError(5, 'Group authorization failed');
    if (method === 'users.get') return vkResponse({ response: [
      { id: 123, first_name: 'Test', last_name: 'Owner' }
    ] });
    if (method === 'groups.getById') {
      assert.equal(body.get('group_id'), '234903751');
      return vkResponse({ response: { groups: [
        { id: 234903751, name: 'Test group', screen_name: 'testgroup' }
      ] } });
    }
    if (method === 'photos.getWallUploadServer') {
      assert.equal(body.get('group_id'), '234903751');
      return vkResponse({ response: { upload_url: 'https://upload.vk.test/photo' } });
    }
  }
  throw new Error(`unexpected VK request ${method}`);
};

try {
  const anonymous = await app.inject({ method: 'POST', url: '/api/vk/token/inspect',
    payload: { credentials: { accessToken: 'valid-group-token' } } });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(calls.length, 0);

  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const inspect = async (accessToken) => app.inject({ method: 'POST', url: '/api/vk/token/inspect',
    headers: { cookie }, payload: { credentials: { accessToken } } });

  const group = await inspect('valid-group-token');
  assert.equal(group.statusCode, 200, group.body);
  assert.equal(group.json().valid, true);
  assert.equal(group.json().authKind, 'COMMUNITY');
  assert.deepEqual(group.json().permissions, ['photos', 'wall']);
  assert.equal(group.body.includes('valid-group-token'), false);
  assert.match(vkCommunityTokenNotice(group.json()), /Ключ VK действителен.*ключ сообщества/);
  assert.deepEqual(calls, ['groups.getTokenPermissions']);

  calls.length = 0;
  const invalid = await inspect('invalid-token');
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.json().error, /ключ недействителен или срок его действия истёк/);
  assert.equal(invalid.body.includes('invalid-token'), false);
  assert.deepEqual(calls, ['groups.getTokenPermissions', 'users.get']);

  calls.length = 0;
  const outage = await inspect('outage-token');
  assert.equal(outage.statusCode, 400);
  assert.match(outage.json().error, /временно недоступна/);
  assert.doesNotMatch(outage.json().error, /недействителен/);

  calls.length = 0;
  const user = await inspect('valid-user-token');
  assert.equal(user.statusCode, 200, user.body);
  assert.equal(user.json().authKind, 'USER');
  assert.equal(user.json().userId, '123');
  assert.equal(user.body.includes('valid-user-token'), false);
  const ready = await app.inject({ method: 'POST', url: '/api/accounts/test', headers: { cookie },
    payload: { platform: 'vk', credentials: { accessToken: 'valid-user-token',
      destinationKind: 'COMMUNITY', groupId: '234903751' } } });
  assert.equal(ready.statusCode, 200, ready.body);
  assert.equal(ready.json().details.wallPhotoReady, true);
  assert.equal(calls.includes('wall.post'), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM social_accounts WHERE platform='vk'").get().n, 0);
  console.log(JSON.stringify({ ok: true, checkpoint: 'VK-KEY-DIAG-001',
    groupValid: true, userReady: true, invalidDistinguished: true,
    outageDistinguished: true, tokenNotExposed: true, wallPostCalls: 0 }));
} finally {
  globalThis.fetch = originalFetch;
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
