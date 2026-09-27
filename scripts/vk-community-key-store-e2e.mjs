import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-group-key-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'vk-group-key-password';
process.env.APP_MASTER_KEY = 'vk-group-key-master-key-longer-than-thirty-two-characters';

const { db, migrate } = await import('../dist/db.js');
const { decryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
const { vkPublisher } = await import('../dist/platforms/vk.js');
migrate();
const app = await buildApp();
await app.ready();

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const method = /\/method\/([^/?]+)/.exec(String(input))?.[1];
  assert.ok(method, `unexpected network request ${String(input)}`);
  const body = new URLSearchParams(String(init.body || ''));
  const token = body.get('access_token');
  calls.push(method);
  if (token === 'valid-community-key') {
    if (method === 'groups.getTokenPermissions') return new Response(JSON.stringify({
      response: { mask: 8196, permissions: [
        { name: 'photos', setting: 4 }, { name: 'wall', setting: 8192 }
      ] }
    }));
    if (method === 'groups.getById') return new Response(JSON.stringify({
      response: { groups: [{ id: 67890, name: 'Test Community', screen_name: 'club67890' }] }
    }));
  }
  if (token === 'invalid-community-key') return new Response(JSON.stringify({
    error: { error_code: 5, error_msg: 'User authorization failed' }
  }));
  throw new Error(`unexpected VK request ${method}`);
};

try {
  const anonymous = await app.inject({ method: 'POST', url: '/api/accounts',
    payload: { platform: 'vk', name: 'VK Group', credentials: {
      accessToken: 'valid-community-key', authKind: 'COMMUNITY',
      destinationKind: 'COMMUNITY', groupId: '67890'
    } } });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(calls.length, 0);

  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const project = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie },
    payload: { name: 'Test Project', slug: 'test-project' } });
  assert.equal(project.statusCode, 201, project.body);

  const invalid = await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie },
    payload: { platform: 'vk', name: 'Bad VK Group', credentials: {
      accessToken: 'invalid-community-key', authKind: 'COMMUNITY',
      destinationKind: 'COMMUNITY', groupId: '67890'
    } } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM social_accounts").get().n, 0);

  const created = await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie },
    payload: { platform: 'vk', name: 'VK Group', credentials: {
      accessToken: 'valid-community-key', authKind: 'COMMUNITY',
      destinationKind: 'COMMUNITY', groupId: 'https://vk.com/club67890'
    } } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().enabled, 0);
  assert.equal(created.json().credentialOnly, true);
  assert.equal(created.body.includes('valid-community-key'), false);
  const accountId = created.json().id;

  const row = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(accountId);
  assert.equal(row.enabled, 0);
  assert.equal(row.credentials_encrypted.includes('valid-community-key'), false);
  const stored = decryptJson(row.credentials_encrypted);
  assert.equal(stored.accessToken, 'valid-community-key');
  assert.equal(stored.authKind, 'COMMUNITY');
  assert.equal(stored.destinationKind, 'COMMUNITY');
  assert.equal(stored.groupId, '67890');
  assert.equal(stored.destinationName, 'Test Community');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_default_targets WHERE account_id=?').get(accountId).n, 0);

  const list = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie } });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json()[0].credential_only, true);
  assert.equal(list.body.includes('valid-community-key'), false);
  const checked = await app.inject({ method: 'POST', url: `/api/accounts/${accountId}/test`, headers: { cookie } });
  assert.equal(checked.statusCode, 200, checked.body);
  assert.equal(checked.json().details.credentialOnly, true);
  assert.equal(checked.body.includes('valid-community-key'), false);

  const enable = await app.inject({ method: 'PATCH', url: `/api/accounts/${accountId}`,
    headers: { cookie }, payload: { enabled: true } });
  assert.equal(enable.statusCode, 409);
  assert.equal(db.prepare('SELECT enabled FROM social_accounts WHERE id=?').get(accountId).enabled, 0);
  assert.throws(() => vkPublisher.validate({
    postId: 'post-1', title: 'Test', text: 'Test', media: [],
    credentials: stored, publicMediaUrls: []
  }), /ключ сообщества.*публикация постов требует пользовательский ключ/);
  assert.equal(calls.includes('wall.post'), false);
  console.log(JSON.stringify({ ok: true, checkpoint: 'VK-GROUP-KEY-STORE-001',
    savedEncrypted: true, disabled: true, defaultTargetExcluded: true,
    retest: true, enableBlocked: true, publicationBlocked: true }));
} finally {
  globalThis.fetch = originalFetch;
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
