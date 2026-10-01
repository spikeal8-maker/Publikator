import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-key-02-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'key-02-password';
process.env.APP_MASTER_KEY = 'key-02-master-key-longer-than-thirty-two-characters';

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
let capturedLogs = '';
process.stdout.write = ((chunk, ...args) => {
  capturedLogs += String(chunk);
  return originalStdoutWrite(chunk, ...args);
});

const { db, migrate } = await import('../dist/db.js');
const { decryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
const { vkPublisher } = await import('../dist/platforms/vk.js');

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
  const method = /\/method\/([^/?]+)/.exec(String(input))?.[1];
  assert.ok(method, `unexpected VK request ${String(input)}`);
  const params = new URLSearchParams(String(init.body || ''));
  const token = params.get('access_token');
  calls.push({ method, token });

  if (token === 'community-key') {
    if (method === 'groups.getTokenPermissions') return json({ response: {
      mask: 8196,
      permissions: [{ name: 'photos', setting: 4 }, { name: 'wall', setting: 8192 }]
    } });
    if (method === 'groups.getById') return json({ response: {
      groups: [{ id: 67890, name: 'Community Fixture', screen_name: 'club67890' }]
    } });
  }

  if (token === 'user-wall-denied' || token === 'user-wall-timeout') {
    if (method === 'groups.getTokenPermissions') return vkError(5, 'Group authorization failed');
    if (method === 'users.get') return json({ response: [
      { id: 12345, first_name: 'User', last_name: 'Fixture', screen_name: 'id12345' }
    ] });
    if (method === 'groups.getById') return json({ response: {
      groups: [{ id: 67890, name: 'Public Community', screen_name: 'club67890' }]
    } });
    if (method === 'photos.getWallUploadServer') {
      if (token === 'user-wall-timeout') {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }
      return vkError(15, 'Access denied: no access to call this method');
    }
  }

  if (token === 'user-personal-mismatch') {
    if (method === 'groups.getTokenPermissions') return vkError(5, 'Group authorization failed');
    if (method === 'users.get') return json({ response: [
      { id: 12345, first_name: 'User', last_name: 'Fixture', screen_name: 'id12345' }
    ] });
    if (method === 'photos.getWallUploadServer') {
      assert.fail('PERSONAL userId mismatch must not call photos.getWallUploadServer');
    }
  }

  throw new Error(`unexpected VK call ${method} for fixture token`);
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

  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers,
    payload: { name: 'KEY-02', slug: 'key-02' }
  });
  assert.equal(project.statusCode, 201, project.body);

  const communityInspect = await app.inject({
    method: 'POST',
    url: '/api/vk/token/inspect',
    headers,
    payload: { credentials: {
      accessToken: 'community-key',
      destinationKind: 'COMMUNITY',
      groupId: '67890'
    } }
  });
  assert.equal(communityInspect.statusCode, 200, communityInspect.body);
  assert.equal(communityInspect.json().valid, true);
  assert.equal(communityInspect.json().authKind, 'COMMUNITY');
  assert.deepEqual(communityInspect.json().permissions, ['photos', 'wall']);
  assert.equal(communityInspect.body.includes('community-key'), false);

  const communitySave = await app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers,
    payload: {
      platform: 'vk',
      name: 'Community Fixture',
      credentials: {
        accessToken: 'community-key',
        apiVersion: '5.199',
        authKind: 'COMMUNITY',
        destinationKind: 'COMMUNITY',
        groupId: '67890'
      }
    }
  });
  assert.equal(communitySave.statusCode, 201, communitySave.body);
  const communityId = communitySave.json().id;
  let stored = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(communityId);
  assert.equal(stored.enabled, 0);
  assert.equal(stored.credentials_encrypted.includes('community-key'), false);
  assert.equal(decryptJson(stored.credentials_encrypted).authKind, 'COMMUNITY');

  const communityRetest = await app.inject({
    method: 'POST',
    url: `/api/accounts/${communityId}/test`,
    headers
  });
  assert.equal(communityRetest.statusCode, 200, communityRetest.body);
  assert.deepEqual(communityRetest.json().details.permissions, ['photos', 'wall']);
  assert.equal(communityRetest.body.includes('community-key'), false);

  const partial = await app.inject({
    method: 'POST',
    url: '/api/accounts/test',
    headers,
    payload: {
      platform: 'vk',
      credentials: {
        accessToken: 'user-wall-denied',
        apiVersion: '5.199',
        destinationKind: 'COMMUNITY',
        groupId: '67890'
      }
    }
  });
  assert.equal(partial.statusCode, 200, partial.body);
  assert.equal(partial.json().details.authenticatedUserName, 'User Fixture');
  assert.equal(partial.json().details.keyValidity, 'CONFIRMED');
  assert.equal(partial.json().details.authKind, 'USER');
  assert.equal(partial.json().details.destinationKind, 'COMMUNITY');
  assert.equal(partial.json().details.destinationId, '67890');
  assert.equal(partial.json().details.destinationOwnershipConfirmed, false);
  assert.equal(partial.json().details.publishReady, false);
  assert.equal(
    partial.json().details.methods.find((item) => item.method === 'photos.getWallUploadServer')?.state,
    'DENIED'
  );
  assert.equal(
    partial.json().details.methods.find((item) => item.method === 'wall.post')?.state,
    'NOT_CHECKED'
  );
  assert.equal(
    partial.json().details.methods.find((item) => item.method === 'photos.getUploadServer')?.state,
    'NOT_IMPLEMENTED'
  );
  assert.equal(partial.body.includes('user-wall-denied'), false);

  const pendingSave = await app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers,
    payload: {
      platform: 'vk',
      name: 'User Partial',
      credentials: {
        accessToken: 'user-wall-denied',
        apiVersion: '5.199',
        authKind: 'PENDING',
        destinationKind: 'COMMUNITY',
        groupId: '67890'
      }
    }
  });
  assert.equal(pendingSave.statusCode, 201, pendingSave.body);
  const pendingId = pendingSave.json().id;
  stored = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(pendingId);
  assert.equal(stored.enabled, 0);
  assert.equal(stored.credentials_encrypted.includes('user-wall-denied'), false);
  assert.equal(decryptJson(stored.credentials_encrypted).authKind, 'PENDING');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM project_default_targets WHERE account_id=?').get(pendingId).n,
    0
  );
  assert.throws(() => vkPublisher.validate({
    postId: 'post-1',
    title: 'Test',
    text: 'Test',
    media: [],
    publicMediaUrls: [],
    credentials: decryptJson(stored.credentials_encrypted)
  }), /ещё не проверен/);

  const afterReloadList = await app.inject({ method: 'GET', url: '/api/accounts', headers });
  assert.equal(afterReloadList.statusCode, 200, afterReloadList.body);
  assert.equal(afterReloadList.json().some((item) => item.id === pendingId), true);
  assert.equal(afterReloadList.body.includes('user-wall-denied'), false);

  const pendingRetest = await app.inject({
    method: 'POST',
    url: `/api/accounts/${pendingId}/test`,
    headers
  });
  assert.equal(pendingRetest.statusCode, 200, pendingRetest.body);
  assert.equal(pendingRetest.json().details.authenticatedUserName, 'User Fixture');
  assert.equal(pendingRetest.json().details.keyValidity, 'CONFIRMED');
  assert.equal(pendingRetest.json().details.publishReady, false);
  assert.equal(pendingRetest.body.includes('user-wall-denied'), false);

  const timeout = await app.inject({
    method: 'POST',
    url: '/api/accounts/test',
    headers,
    payload: {
      platform: 'vk',
      credentials: {
        accessToken: 'user-wall-timeout',
        apiVersion: '5.199',
        destinationKind: 'PERSONAL'
      }
    }
  });
  assert.equal(timeout.statusCode, 200, timeout.body);
  assert.equal(timeout.json().details.authenticatedUserName, 'User Fixture');
  assert.equal(timeout.json().details.keyValidity, 'CONFIRMED');
  assert.equal(timeout.json().details.publishReady, false);
  assert.equal(
    timeout.json().details.methods.find((item) => item.method === 'photos.getWallUploadServer')?.state,
    'UNAVAILABLE'
  );
  assert.doesNotMatch(JSON.stringify(timeout.json()), /invalid|недействител/i);
  assert.equal(timeout.body.includes('user-wall-timeout'), false);

  const personalMismatch = await app.inject({
    method: 'POST',
    url: '/api/accounts/test',
    headers,
    payload: {
      platform: 'vk',
      credentials: {
        accessToken: 'user-personal-mismatch',
        apiVersion: '5.199',
        destinationKind: 'PERSONAL',
        userId: '99999'
      }
    }
  });
  assert.equal(personalMismatch.statusCode, 200, personalMismatch.body);
  assert.equal(personalMismatch.json().details.keyValidity, 'CONFIRMED');
  assert.equal(personalMismatch.json().details.authKind, 'USER');
  assert.equal(personalMismatch.json().details.authenticatedUserId, '12345');
  assert.equal(personalMismatch.json().details.authenticatedUserName, 'User Fixture');
  assert.equal(personalMismatch.json().details.destinationKind, 'PERSONAL');
  assert.equal(personalMismatch.json().details.destinationId, '99999');
  assert.equal(personalMismatch.json().details.destinationStatus, 'DENIED');
  assert.equal(personalMismatch.json().details.destinationOwnershipConfirmed, false);
  assert.equal(personalMismatch.json().details.publishReady, false);
  assert.equal(personalMismatch.json().details.wallPhotoReady, false);
  assert.equal(personalMismatch.json().details.wallUploadReady, false);
  assert.equal(personalMismatch.json().details.wallPostNotExecuted, true);
  assert.equal(
    personalMismatch.json().details.methods.find((item) => item.method === 'users.get')?.state,
    'CONFIRMED'
  );
  assert.equal(
    personalMismatch.json().details.methods.find((item) => item.method === 'photos.getWallUploadServer')?.state,
    'NOT_CHECKED'
  );
  assert.match(
    personalMismatch.json().details.methods.find((item) => item.method === 'photos.getWallUploadServer')?.reason || '',
    /PERSONAL userId id99999.*USER token id12345/
  );
  assert.match(personalMismatch.json().destination, /id99999/);
  assert.equal(personalMismatch.body.includes('user-personal-mismatch'), false);
  assert.equal(
    calls.some((call) => call.token === 'user-personal-mismatch' && call.method === 'photos.getWallUploadServer'),
    false
  );

  const secrets = ['community-key', 'user-wall-denied', 'user-wall-timeout', 'user-personal-mismatch'];
  for (const secret of secrets) assert.equal(capturedLogs.includes(secret), false, 'fixture secret leaked to logs');
  assert.equal(calls.some((call) => call.method === 'wall.post'), false);

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'KEY-02',
    communityPermissionsPreserved: true,
    userIdentityPreservedAfterWallUploadFailure: true,
    timeoutIsUnavailable: true,
    personalDestinationMismatchDenied: true,
    personalMismatchWallUploadCalls: calls.filter((call) =>
      call.token === 'user-personal-mismatch' && call.method === 'photos.getWallUploadServer'
    ).length,
    pendingReloadRetest: true,
    noPublishBypass: true,
    wallPostCalls: 0
  }));
} finally {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
