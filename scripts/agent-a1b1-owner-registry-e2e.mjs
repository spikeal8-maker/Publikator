import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-agent-a1b1-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = 'a1b1-test-master-key-never-shared-with-a-bot-2026';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
const { createAdminSetupGrant, createOrRecoverAdmin } = await import('../dist/admin-auth.js');
const { createSessionToken } = await import('../dist/crypto.js');

migrate();
const token = createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'),
  'publikator_owner', 'owner-a1b1-strong-password-2026', 'owner-a1b1-strong-password-2026');
const cookie = 'publikator_session=' + token;
const origin = 'https://publisher.example.test';
const safeAuth = { cookie, origin };
let app = await buildApp();

async function send(method, url, payload, headers = {}) {
  return app.inject({
    method, url, headers,
    ...(payload === undefined ? {} : { payload })
  });
}
function count(table) {
  return db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}

try {
  assert.equal(Number(db.pragma('user_version', { simple: true })), 16);
  const initial = count('agent_principals');
  assert.equal(initial, 0);
  assert.equal((await send('GET', '/api/owner/agents')).statusCode, 401);
  assert.equal((await send('GET', '/api/owner/agents', undefined,
    { authorization: 'Bearer faked-agent-bearer' })).statusCode, 401);
  assert.equal((await send('GET', '/api/owner/agents', undefined,
    { ...safeAuth, authorization: 'Bearer faked-agent-bearer' })).statusCode, 401,
    'owner routes must not permit mixed cookie+agent authorization');
  assert.equal((await send('GET', '/api/owner/agents', undefined,
    { cookie: 'publikator_session=' + createSessionToken() })).statusCode, 401,
    'legacy administrator tokens cannot manage agent grants in login mode');

  const first = { name: 'School content assistant', clientKind: 'chatgpt' };
  const endpoint = '/api/owner/agents';
  assert.equal((await send('POST', endpoint, first,
    { cookie, 'idempotency-key': 'a1b1-create-001' })).statusCode, 403,
    'a mutating owner operation without Origin must fail closed');
  assert.equal((await send('POST', endpoint, first,
    { ...safeAuth, origin: 'https://attacker.example', 'idempotency-key': 'a1b1-create-001' })).statusCode, 403);
  assert.equal((await send('POST', endpoint, first, safeAuth)).statusCode, 400,
    'an owner creation request needs a persisted idempotency key');
  assert.equal((await send('POST', endpoint, {
    ...first, presetId: 'FULL_CONTENT', projectIds: ['project_without_consent']
  }, { ...safeAuth, 'idempotency-key': 'a1b1-elevate-001' })).statusCode, 403,
  'registration cannot silently grant a permission preset or resource');
  assert.equal(count('agent_principals'), 0);

  const created = await Promise.all([
    send('POST', endpoint, first, { ...safeAuth, 'idempotency-key': 'a1b1-create-001' }),
    send('POST', endpoint, first, { ...safeAuth, 'idempotency-key': 'a1b1-create-001' })
  ]);
  assert.deepEqual(created.map(r => r.statusCode), [201, 201]);
  const a = created[0].json();
  assert.deepEqual(created[1].json(), a);
  assert.match(a.agentId, /^agent_/);
  assert.equal(a.status, 'ACTIVE');
  assert.equal(a.grant.presetId, 'OBSERVER');
  assert.equal(a.grant.presetVersion, 1);
  assert.equal(a.grant.grantVersion, 1);
  assert.equal(a.grant.publishMode, 'DRAFT_ONLY');
  for (const field of ['scopeIds', 'projectIds', 'accountIds', 'sourceConnectorIds']) {
    assert.deepEqual(a.grant[field], [], field);
  }
  assert.equal(count('agent_principals'), 1);
  assert.equal(count('agent_grants'), 1);
  assert.equal(count('agent_activity_events'), 1);
  assert.equal((await send('POST', endpoint, {
    name: 'Different content', clientKind: 'chatgpt'
  }, { ...safeAuth, 'idempotency-key': 'a1b1-create-001' })).statusCode, 409);
  assert.equal(count('agent_principals'), 1);

  const second = await send('POST', endpoint,
    { name: 'Research helper', clientKind: 'n8n', presetId: 'OBSERVER',
      scopeIds: [], projectIds: [], accountIds: [], sourceConnectorIds: [],
      publishMode: 'DRAFT_ONLY' },
    { ...safeAuth, 'idempotency-key': 'a1b1-create-002' });
  assert.equal(second.statusCode, 201, second.body);
  const b = second.json();
  assert.notEqual(a.agentId, b.agentId);
  assert.equal(count('agent_principals'), 2);
  const firstPage = await send('GET', endpoint + '?limit=1', undefined, { cookie });
  assert.equal(firstPage.statusCode, 200, firstPage.body);
  assert.equal(firstPage.json().items.length, 1);
  assert.equal(firstPage.json().pagination.limit, 1);
  assert.ok(firstPage.json().pagination.nextCursor);
  const secondPage = await send('GET',
    endpoint + '?limit=1&cursor=' + firstPage.json().pagination.nextCursor,
    undefined, { cookie });
  assert.equal(secondPage.statusCode, 200, secondPage.body);
  assert.equal(secondPage.json().items.length, 1);
  assert.notEqual(firstPage.json().items[0].agentId, secondPage.json().items[0].agentId);
  assert.equal((await send('GET', endpoint + '?limit=101', undefined, { cookie })).statusCode, 400);
  assert.equal((await send('GET', endpoint + '?cursor=bad-base64', undefined, { cookie })).statusCode, 400);
  assert.equal((await send('GET', endpoint + '/' + a.agentId, undefined, { cookie })).statusCode, 200);
  assert.equal((await send('GET', endpoint + '/' + a.agentId, undefined,
    { authorization: 'Bearer faked-agent' })).statusCode, 401);
  assert.equal((await send('GET', endpoint + '/nonexistent', undefined, { cookie })).statusCode, 404);

  // A1b2a now provides this endpoint, but an incomplete or unauthorized
  // request must never silently elevate an A1b1 default-deny registration.
  assert.equal((await send('PUT', endpoint + '/' + a.agentId + '/grant', {
    expectedGrantVersion: 1, presetId: 'FULL_CONTENT'
  }, safeAuth)).statusCode, 400);
  assert.deepEqual(JSON.parse(db.prepare('SELECT scope_ids_json FROM agent_grants WHERE agent_id=?')
    .get(a.agentId).scope_ids_json), [], 'invalid grant input cannot elevate');

  const pauseUrl = endpoint + '/' + a.agentId + '/pause';
  const revokeUrl = endpoint + '/' + a.agentId + '/revoke';
  assert.equal((await send('POST', pauseUrl, {
    expectedGrantVersion: 3, confirm: true
  }, { ...safeAuth, 'idempotency-key': 'a1b1-pause-001' })).statusCode, 409);
  assert.equal((await send('POST', pauseUrl, {
    expectedGrantVersion: 1, confirm: false
  }, { ...safeAuth, 'idempotency-key': 'a1b1-pause-001' })).statusCode, 400);
  const pauseBody = { expectedGrantVersion: 1, confirm: true };
  const pauseHeaders = { ...safeAuth, 'idempotency-key': 'a1b1-pause-001' };
  const paused = await send('POST', pauseUrl, pauseBody, pauseHeaders);
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().status, 'PAUSED');
  assert.equal(paused.json().grantVersion, 2);
  assert.equal((await send('POST', pauseUrl, pauseBody, pauseHeaders)).json().grantVersion, 2);
  assert.equal(db.prepare('SELECT token_version FROM agent_principals WHERE id=?').get(a.agentId).token_version, 2);
  assert.equal((await send('POST', pauseUrl, pauseBody, {
    ...safeAuth, 'idempotency-key': 'a1b1-pause-other-key'
  })).statusCode, 409);
  assert.equal((await send('POST', pauseUrl, {
    expectedGrantVersion: 2, confirm: true
  }, { ...safeAuth, 'idempotency-key': 'a1b1-pause-again' })).statusCode, 409);

  const revoked = await send('POST', revokeUrl,
    { expectedGrantVersion: 2, confirm: true },
    { ...safeAuth, 'idempotency-key': 'a1b1-revoke-001' });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json().status, 'REVOKED');
  assert.equal(revoked.json().grantVersion, 3);
  assert.equal(db.prepare('SELECT token_version FROM agent_principals WHERE id=?').get(a.agentId).token_version, 3);
  const oldPauseReplay = await send('POST', pauseUrl,
    { confirm: true, expectedGrantVersion: 1 }, pauseHeaders);
  assert.equal(oldPauseReplay.statusCode, 200, oldPauseReplay.body);
  assert.deepEqual(oldPauseReplay.json(), paused.json());
  const originalCreateReplay = await send('POST', endpoint,
    { clientKind: 'chatgpt', name: 'School content assistant' },
    { ...safeAuth, 'idempotency-key': 'a1b1-create-001' });
  assert.equal(originalCreateReplay.statusCode, 201, originalCreateReplay.body);
  assert.deepEqual(originalCreateReplay.json(), a);
  assert.equal(count('agent_owner_operation_receipts'), 4);
  assert.equal((await send('POST', pauseUrl, {
    expectedGrantVersion: 3, confirm: true
  }, { ...safeAuth, 'idempotency-key': 'a1b1-pause-revoked' })).statusCode, 409);

  const activity = await send('GET', endpoint + '/' + a.agentId + '/activity?limit=2', undefined,
    { cookie });
  assert.equal(activity.statusCode, 200, activity.body);
  const timeline = activity.json();
  assert.equal(timeline.items.length, 2);
  assert.ok(timeline.pagination.nextCursor);
  assert.deepEqual(timeline.items.map(e => e.stage), ['REVOKED', 'PAUSED']);
  const older = await send('GET', endpoint + '/' + a.agentId + '/activity?limit=2&cursor='
    + timeline.pagination.nextCursor, undefined, { cookie });
  assert.equal(older.statusCode, 200, older.body);
  assert.equal(older.json().items.length, 1);
  assert.equal(older.json().items[0].stage, 'COMPLETED');
  assert.equal(count('agent_activity_events'), 4,
    'two registrations plus pause and revoke; idempotent replay adds no duplicate');
  assert.equal((await send('GET', endpoint + '/' + a.agentId + '/activity',
    undefined, { authorization: 'Bearer faked-agent' })).statusCode, 401);
  const sanitized = JSON.stringify(timeline);
  assert.ok(!sanitized.includes(process.env.APP_MASTER_KEY));
  assert.ok(!sanitized.includes(token));
  assert.ok(!sanitized.includes('a1b1-pause-001'),
    'plain-text idempotency keys cannot appear in audit');
  assert.deepEqual(JSON.parse(db.prepare('SELECT scope_ids_json FROM agent_grants WHERE agent_id=?')
    .get(a.agentId).scope_ids_json), []);

  await app.close();
  app = await buildApp();
  const reread = await send('GET', endpoint + '/' + a.agentId, undefined, { cookie });
  assert.equal(reread.statusCode, 200, reread.body);
  assert.equal(reread.json().status, 'REVOKED');
  assert.equal(reread.json().grant.grantVersion, 3);
  assert.equal(count('agent_activity_events'), 4);
  const persistedReplay = await send('POST', pauseUrl,
    { confirm: true, expectedGrantVersion: 1 }, pauseHeaders);
  assert.equal(persistedReplay.statusCode, 200, persistedReplay.body);
  assert.deepEqual(persistedReplay.json(), paused.json());

  console.log(JSON.stringify({
    ok: true, checkpoint: 'AGENT-A1b1', schema: 16, defaultDeny: true,
    ownerSessionOnly: true, strictOrigin: true, noMachineKeysOrOAuth: true,
    idempotency: true, persistentAudit: true, restartSafe: true
  }));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
