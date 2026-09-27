import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ADMIN_PASSWORD = 'vk-oauth-start-password';
const APP_MASTER_KEY = 'vk-oauth-start-master-key-longer-than-thirty-two-characters';
const CLIENT_ID = '12345678';
const REDIRECT_URI = 'https://publisher.example.test/api/vk/oauth/callback';
const CLIENT_SECRET_SENTINEL = 'vk-client-secret-must-never-be-returned';
const REQUIRED_SCOPES = new Set(['wall', 'groups', 'photos', 'offline']);
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-oauth-start-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = APP_MASTER_KEY;
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';
process.env.VK_OAUTH_CLIENT_ID = CLIENT_ID;
process.env.VK_OAUTH_REDIRECT_URI = REDIRECT_URI;
process.env.VK_OAUTH_CLIENT_SECRET = CLIENT_SECRET_SENTINEL;

const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
const { consumeVkOauthState } = await import('../dist/http/vk-oauth.js');

migrate();
const app = await buildApp();
await app.ready();

try {
  const unauthenticated = await app.inject({ method: 'GET', url: '/api/vk/oauth/start' });
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: ADMIN_PASSWORD }
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];

  const start = await app.inject({
    method: 'GET',
    url: '/api/vk/oauth/start',
    headers: { cookie }
  });
  assert.equal(start.statusCode, 200, start.body);

  const payload = start.json();
  assert.equal(typeof payload.authorizationUrl, 'string');
  const authorizationUrl = new URL(payload.authorizationUrl);

  assert.equal(authorizationUrl.origin, 'https://oauth.vk.com');
  assert.equal(authorizationUrl.pathname, '/authorize');
  assert.equal(authorizationUrl.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorizationUrl.searchParams.get('response_type'), 'code');
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), REDIRECT_URI);

  const scopes = new Set(
    String(authorizationUrl.searchParams.get('scope') || '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
  );
  assert.deepEqual(scopes, REQUIRED_SCOPES);

  const state = String(authorizationUrl.searchParams.get('state') || '');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(consumeVkOauthState(state), true, 'issued state must be stored server-side');
  assert.equal(consumeVkOauthState(state), false, 'state must be one-time');

  const second = await app.inject({
    method: 'GET',
    url: '/api/vk/oauth/start',
    headers: { cookie }
  });
  assert.equal(second.statusCode, 200, second.body);
  const secondState = new URL(second.json().authorizationUrl).searchParams.get('state');
  assert.ok(secondState);
  assert.notEqual(secondState, state, 'each start request must receive a fresh random state');
  assert.equal(
    consumeVkOauthState(secondState, Date.now() + 5 * 60 * 1000 + 1),
    false,
    'state must expire after the short TTL'
  );

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(CLIENT_SECRET_SENTINEL), false);
  assert.equal(serialized.includes('client_secret'), false);
  assert.equal(serialized.includes('access_token'), false);
  assert.equal(authorizationUrl.searchParams.has('client_secret'), false);
  assert.equal(authorizationUrl.searchParams.has('access_token'), false);

  const callback = await app.inject({
    method: 'GET',
    url: '/api/vk/oauth/callback?code=not-used&state=not-used',
    headers: { cookie }
  });
  assert.equal(callback.statusCode, 400, 'callback must reject an unknown one-time state');

  delete process.env.VK_OAUTH_CLIENT_ID;
  delete process.env.VK_OAUTH_REDIRECT_URI;

  const missingConfig = await app.inject({
    method: 'GET',
    url: '/api/vk/oauth/start',
    headers: { cookie }
  });
  assert.equal(missingConfig.statusCode, 503, missingConfig.body);
  const missingPayload = missingConfig.json();
  assert.match(String(missingPayload.error || ''), /VK OAuth не настроен/);
  assert.equal(JSON.stringify(missingPayload).includes(CLIENT_SECRET_SENTINEL), false);

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'VK-OAUTH-START',
    authorizationCodeFlow: true,
    responseType: 'code',
    redirectUri: REDIRECT_URI,
    requiredScopes: [...REQUIRED_SCOPES],
    stateStoredServerSide: true,
    stateOneTime: true,
    stateTtlSeconds: 300,
    clientSecretExposed: false,
    accessTokenObtained: false,
    callbackImplemented: false,
    failClosedWithoutConfig: true
  }, null, 2));
} finally {
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
