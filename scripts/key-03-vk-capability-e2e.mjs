import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-key-03-capability-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'key-03-capability-password';
process.env.APP_MASTER_KEY = 'key-03-capability-master-key-longer-than-thirty-two-characters';

const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');

migrate();
const app = await buildApp();
await app.ready();

const originalFetch = globalThis.fetch;
const calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});
const vkError = (code, message) => json({ error: { error_code: code, error_msg: message } });

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = /\/method\/([^/?]+)/.exec(url)?.[1];
  assert.ok(method, `connection diagnostics must not POST to upload hosts: ${url}`);
  const params = new URLSearchParams(String(init.body || ''));
  const token = params.get('access_token');
  calls.push({ method, token, params: Object.fromEntries(params.entries()) });

  if (token !== 'user-album-fallback') throw new Error(`unexpected token for ${method}`);
  if (method === 'groups.getTokenPermissions') return vkError(5, 'Group authorization failed');
  if (method === 'users.get') return json({ response: [
    { id: 12345, first_name: 'Album', last_name: 'Owner', screen_name: 'id12345' }
  ] });
  if (method === 'groups.getById') return json({ response: {
    groups: [{ id: 67890, name: 'Album Community', screen_name: 'club67890' }]
  } });
  if (method === 'photos.getWallUploadServer') return vkError(15, 'Access denied: wall upload unavailable');
  if (method === 'photos.getUploadServer') {
    assert.equal(params.get('album_id'), '777');
    assert.equal(params.get('group_id'), '67890');
    return json({ response: { upload_url: 'https://upload.vk.test/album-safe-probe' } });
  }
  if (method === 'photos.save' || method === 'wall.post') assert.fail(`diagnostics must not call ${method}`);
  throw new Error(`unexpected VK method ${method}`);
};

try {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: process.env.ADMIN_PASSWORD }
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const headers = { cookie };

  const checked = await app.inject({
    method: 'POST',
    url: '/api/accounts/test',
    headers,
    payload: {
      platform: 'vk',
      credentials: {
        accessToken: 'user-album-fallback',
        apiVersion: '5.199',
        destinationKind: 'COMMUNITY',
        groupId: '67890',
        albumId: '000777'
      }
    }
  });
  assert.equal(checked.statusCode, 200, checked.body);
  const result = checked.json();
  assert.equal(result.details.keyValidity, 'CONFIRMED');
  assert.equal(result.details.authKind, 'USER');
  assert.equal(result.details.authenticatedUserId, '12345');
  assert.equal(result.details.destinationKind, 'COMMUNITY');
  assert.equal(result.details.destinationId, '67890');
  assert.equal(result.details.destinationStatus, 'CONFIRMED');
  assert.equal(result.details.wallPhotoReady, false);
  assert.equal(result.details.wallUploadReady, false);
  assert.equal(result.details.albumUploadReady, true);
  assert.equal(result.details.albumId, '777');
  assert.equal(result.details.imageUploadMode, 'ALBUM');
  assert.equal(result.details.publishReady, true);
  assert.equal(
    result.details.methods.find((item) => item.method === 'photos.getWallUploadServer')?.state,
    'DENIED'
  );
  assert.equal(
    result.details.methods.find((item) => item.method === 'photos.getUploadServer')?.state,
    'CONFIRMED'
  );
  assert.equal(
    result.details.methods.find((item) => item.method === 'photos.save')?.state,
    'NOT_CHECKED'
  );
  assert.equal(
    result.details.methods.find((item) => item.method === 'wall.post')?.state,
    'NOT_CHECKED'
  );
  assert.equal(checked.body.includes('user-album-fallback'), false);

  assert.ok(calls.filter((call) => call.method === 'photos.getWallUploadServer').length >= 1);
  assert.equal(calls.filter((call) => call.method === 'photos.getUploadServer').length, 1);
  assert.equal(calls.filter((call) => call.method === 'photos.save').length, 0);
  assert.equal(calls.filter((call) => call.method === 'wall.post').length, 0);

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'KEY-03-CAPABILITY',
    wallPhotoReady: result.details.wallPhotoReady,
    albumUploadReady: result.details.albumUploadReady,
    imageUploadMode: result.details.imageUploadMode,
    publishReady: result.details.publishReady,
    albumProbeCalls: calls.filter((call) => call.method === 'photos.getUploadServer').length,
    photosSaveCalls: 0,
    wallPostCalls: 0
  }));
} finally {
  globalThis.fetch = originalFetch;
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
