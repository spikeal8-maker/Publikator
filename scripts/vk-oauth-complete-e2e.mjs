import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ADMIN_PASSWORD = 'vk-oauth-complete-password';
const APP_MASTER_KEY = 'vk-oauth-complete-master-key-longer-than-thirty-two-characters';
const CLIENT_ID = '12345678';
const CLIENT_SECRET = 'vk-test-secret-never-expose';
const REDIRECT_URI = 'https://publisher.example.test/api/vk/oauth/callback';
const USER_TOKEN = 'vk-user-token-never-expose';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-oauth-complete-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = APP_MASTER_KEY;
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';
process.env.VK_OAUTH_CLIENT_ID = CLIENT_ID;
process.env.VK_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
process.env.VK_OAUTH_REDIRECT_URI = REDIRECT_URI;

const { db, migrate } = await import('../dist/db.js');
const { decryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();
await app.ready();

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin === 'https://oauth.vk.com' && url.pathname === '/access_token') {
    calls.push('token');
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(url.searchParams.get('client_secret'), CLIENT_SECRET);
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.equal(url.searchParams.get('code'), 'test-code');
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ access_token: USER_TOKEN, user_id: 123, expires_in: 0 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  const method = /\/method\/([^/?]+)/.exec(url.pathname)?.[1];
  assert.ok(method, `unexpected fetch ${url.origin}${url.pathname}`);
  calls.push(method);
  const body = new URLSearchParams(String(init.body || ''));
  assert.equal(body.get('access_token'), USER_TOKEN);
  if (method === 'users.get') return new Response(JSON.stringify({
    response: [{ id: 123, first_name: 'Test', last_name: 'User', screen_name: 'testuser' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (method === 'groups.getById') {
    assert.equal(body.get('group_id'), '234903751');
    return new Response(JSON.stringify({ response: { groups: [{ id: 234903751, name: 'Test group', screen_name: 'testgroup' }] } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  if (method === 'photos.getWallUploadServer') {
    assert.equal(body.get('group_id'), '234903751');
    return new Response(JSON.stringify({ response: { upload_url: 'https://upload.vk.test/photo' } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  throw new Error(`unexpected VK method ${method}`);
};

try {
  const unauthenticated = await app.inject({ method: 'GET', url: '/api/vk/oauth/start' });
  assert.equal(unauthenticated.statusCode, 401);

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];

  const invalid = await app.inject({ method: 'GET', url: '/api/vk/oauth/callback?state=invalid&code=test-code' });
  assert.equal(invalid.statusCode, 400);
  assert.equal(calls.length, 0, 'invalid state must never exchange a code');

  const startUrl = '/api/vk/oauth/start?name=Test%20connection&destinationKind=COMMUNITY&groupId=-234903751';
  const start = await app.inject({ method: 'GET', url: startUrl, headers: { cookie } });
  assert.equal(start.statusCode, 200, start.body);
  const authorizationUrl = new URL(start.json().authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(authorizationUrl.searchParams.get('response_type'), 'code');
  assert.equal(authorizationUrl.searchParams.has('client_secret'), false);
  const state = authorizationUrl.searchParams.get('state');
  assert.ok(state);

  const callback = await app.inject({
    method: 'GET', url: `/api/vk/oauth/callback?state=${encodeURIComponent(state)}&code=test-code`
  });
  assert.equal(callback.statusCode, 302, callback.body);
  assert.match(String(callback.headers.location), /^\/socials\?vk_oauth_result=/);
  assert.deepEqual(calls, ['token', 'users.get', 'groups.getById', 'photos.getWallUploadServer']);
  assert.equal(JSON.stringify(callback.headers).includes(USER_TOKEN), false);
  assert.equal(JSON.stringify(callback.headers).includes(CLIENT_SECRET), false);

  const ticket = new URL(String(callback.headers.location), 'https://publisher.example.test').searchParams.get('vk_oauth_result');
  assert.ok(ticket);
  const resultUnauthenticated = await app.inject({ method: 'GET', url: `/api/vk/oauth/result?ticket=${ticket}` });
  assert.equal(resultUnauthenticated.statusCode, 401);
  const result = await app.inject({ method: 'GET', url: `/api/vk/oauth/result?ticket=${ticket}`, headers: { cookie } });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().ok, true);
  assert.equal(result.body.includes(USER_TOKEN), false);
  const replayResult = await app.inject({ method: 'GET', url: `/api/vk/oauth/result?ticket=${ticket}`, headers: { cookie } });
  assert.equal(replayResult.statusCode, 404);

  const rows = db.prepare("SELECT * FROM social_accounts WHERE platform='vk'").all();
  assert.equal(rows.length, 1);
  const stored = decryptJson(rows[0].credentials_encrypted);
  assert.equal(stored.accessToken, USER_TOKEN);
  assert.equal(stored.destinationKind, 'COMMUNITY');
  assert.equal(stored.groupId, '234903751');
  assert.equal(stored.authKind, 'USER');
  assert.equal(rows[0].name, 'Test connection');
  const list = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.includes(USER_TOKEN), false);

  const replay = await app.inject({
    method: 'GET', url: `/api/vk/oauth/callback?state=${encodeURIComponent(state)}&code=test-code`
  });
  assert.equal(replay.statusCode, 400);
  assert.equal(calls.length, 4);

  const deniedStart = await app.inject({ method: 'GET', url: startUrl, headers: { cookie } });
  const deniedState = new URL(deniedStart.json().authorizationUrl).searchParams.get('state');
  const denied = await app.inject({ method: 'GET', url: `/api/vk/oauth/callback?state=${deniedState}&error=access_denied` });
  assert.equal(denied.statusCode, 302);
  assert.equal(calls.length, 4, 'denied authorization must not exchange a code');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM social_accounts WHERE platform='vk'").get().count, 1);

  const source = await fs.readFile(new URL('../public/operator-pages-v4.js', import.meta.url), 'utf8');
  assert.match(source, /operator-vk-oauth/);
  assert.match(source, /vk_oauth_result/);
  console.log(JSON.stringify({ ok: true, checkpoint: 'VK-OAUTH-COMPLETE', created: true,
    stateReplayBlocked: true, deniedNoSideEffect: true, tokenEncrypted: true,
    callbackWithoutSessionCookie: true, wallPostDuringCheck: false }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
