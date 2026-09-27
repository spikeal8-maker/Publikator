import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-pending-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'vk-pending-password';
process.env.APP_MASTER_KEY = 'vk-pending-master-key-longer-than-thirty-two-characters';

const { db, migrate } = await import('../dist/db.js');
const { decryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
const { vkPublisher } = await import('../dist/platforms/vk.js');
migrate();
const app = await buildApp();
await app.ready();

const originalFetch = globalThis.fetch;
const calls = [];
const response = (data) => new Response(JSON.stringify(data), {
  headers: { 'content-type': 'application/json' }
});
globalThis.fetch = async (input, init = {}) => {
  const method = /\/method\/([^/?]+)/.exec(String(input))?.[1];
  assert.ok(method, `unexpected network request ${String(input)}`);
  const params = new URLSearchParams(String(init.body || ''));
  const token = params.get('access_token');
  calls.push({ method, token });
  if (token === 'ip-bound-key') return response({
    error: { error_code: 5, error_msg: 'User authorization failed: access_token was given to another ip address' }
  });
  if (token === 'valid-group-key') {
    if (method === 'groups.getTokenPermissions') return response({
      response: { mask: 8192, permissions: [{ name: 'wall', setting: 8192 }] }
    });
    if (method === 'groups.getById') return response({
      response: { groups: [{ id: 234601853, name: 'VK Group', screen_name: 'club234601853' }] }
    });
  }
  if (token === 'valid-user-key') {
    if (method === 'groups.getTokenPermissions') return response({
      error: { error_code: 5, error_msg: 'Group authorization failed' }
    });
    if (method === 'users.get') return response({
      response: [{ id: 12345, first_name: 'Test', last_name: 'User' }]
    });
    if (method === 'photos.getWallUploadServer') return response({
      response: { upload_url: 'https://upload.vk.test/photo' }
    });
  }
  throw new Error(`unexpected VK call ${method} for ${token}`);
};

try {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const headers = { cookie };
  const project = await app.inject({ method: 'POST', url: '/api/projects', headers,
    payload: { name: 'Test Project', slug: 'test-project' } });
  assert.equal(project.statusCode, 201, project.body);

  const blank = await app.inject({ method: 'POST', url: '/api/accounts', headers,
    payload: { platform: 'vk', name: 'Empty', credentials: {
      authKind: 'PENDING', accessToken: '', destinationKind: 'COMMUNITY'
    } } });
  assert.equal(blank.statusCode, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM social_accounts").get().n, 0);

  const save = async (name, accessToken, destinationKind, groupId) => {
    const before = calls.length;
    const result = await app.inject({ method: 'POST', url: '/api/accounts', headers,
      payload: { platform: 'vk', name, credentials: {
        authKind: 'PENDING', accessToken, destinationKind, ...(groupId ? { groupId } : {})
      } } });
    assert.equal(result.statusCode, 201, result.body);
    assert.equal(calls.length, before, 'saving PENDING must not contact VK');
    assert.equal(result.json().enabled, 0);
    assert.equal(result.json().credentialOnly, true);
    assert.equal(result.body.includes(accessToken), false);
    return result.json().id;
  };

  const boundId = await save('Bound', 'ip-bound-key', 'COMMUNITY', '234601853');
  let row = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(boundId);
  assert.equal(row.enabled, 0);
  assert.equal(row.credentials_encrypted.includes('ip-bound-key'), false);
  assert.equal(decryptJson(row.credentials_encrypted).authKind, 'PENDING');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_default_targets WHERE account_id=?').get(boundId).n, 0);
  assert.throws(() => vkPublisher.validate({
    postId: 'post-1', title: 'Test', text: 'Test', media: [], publicMediaUrls: [],
    credentials: decryptJson(row.credentials_encrypted)
  }), /ещё не проверен/);

  const list = await app.inject({ method: 'GET', url: '/api/accounts', headers });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().find((item) => item.id === boundId).verification_status, 'PENDING');
  assert.equal(list.json().find((item) => item.id === boundId).credential_only, true);
  assert.equal(list.body.includes('ip-bound-key'), false);

  const blockedEnable = await app.inject({ method: 'PATCH', url: `/api/accounts/${boundId}`, headers,
    payload: { enabled: true } });
  assert.equal(blockedEnable.statusCode, 409);
  const failedTest = await app.inject({ method: 'POST', url: `/api/accounts/${boundId}/test`, headers });
  assert.equal(failedTest.statusCode, 400, failedTest.body);
  assert.match(failedTest.body, /другому IP-адресу/);
  const failedActivate = await app.inject({ method: 'POST', url: `/api/accounts/${boundId}/activate`, headers });
  assert.equal(failedActivate.statusCode, 400, failedActivate.body);
  assert.equal(db.prepare('SELECT enabled FROM social_accounts WHERE id=?').get(boundId).enabled, 0);

  const groupId = await save('Group', 'valid-group-key', 'COMMUNITY', '234601853');
  const groupActivate = await app.inject({ method: 'POST', url: `/api/accounts/${groupId}/activate`, headers });
  assert.equal(groupActivate.statusCode, 200, groupActivate.body);
  assert.equal(groupActivate.json().authKind, 'COMMUNITY');
  row = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(groupId);
  assert.equal(row.enabled, 0);
  assert.equal(decryptJson(row.credentials_encrypted).authKind, 'COMMUNITY');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_default_targets WHERE account_id=?').get(groupId).n, 0);

  const userId = await save('User', 'valid-user-key', 'PERSONAL');
  const userActivate = await app.inject({ method: 'POST', url: `/api/accounts/${userId}/activate`, headers });
  assert.equal(userActivate.statusCode, 200, userActivate.body);
  assert.equal(userActivate.json().authKind, 'USER');
  row = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(userId);
  assert.equal(row.enabled, 1);
  assert.equal(decryptJson(row.credentials_encrypted).userId, '12345');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM project_default_targets WHERE account_id=?').get(userId).n >= 1);
  assert.equal(calls.some((call) => call.method === 'wall.post'), false);
  console.log(JSON.stringify({ ok: true, checkpoint: 'VK-KEY-PENDING-001',
    encrypted: true, ipErrorClear: true, disabledUntilVerified: true,
    communityLimited: true, userActivated: true }));
} finally {
  globalThis.fetch = originalFetch;
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
