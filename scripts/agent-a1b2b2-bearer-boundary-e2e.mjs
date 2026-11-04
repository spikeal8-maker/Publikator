import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-agent-a1b2b2-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = 'agent-bearer-boundary-master-key-not-a-token-2026';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
const { createAdminSetupGrant, createOrRecoverAdmin } = await import('../dist/admin-auth.js');
const { createOwnerAgent, controlOwnerAgent } = await import('../dist/agent-owner-registry.js');
const { updateOwnerAgentGrant } = await import('../dist/agent-owner-grants.js');
const { encryptJson } = await import('../dist/crypto.js');

migrate();
let app = await buildApp();
const session = createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'),
  'machine_owner', 'boundary-owner-strong-password-2026', 'boundary-owner-strong-password-2026');
const owner = { cookie: 'publikator_session=' + session, origin: 'https://publisher.example.test' };
const endpoint = '/api/agent/v1/capabilities';
const readHeaders = token => ({ authorization: 'Bearer ' + token });
async function send(method, url, payload, headers = {}) {
  return app.inject({
    method, url, headers,
    ...(payload === undefined ? {} : { payload })
  });
}
function eventCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM agent_activity_events').get().n;
}

try {
  assert.equal(Number(db.pragma('user_version', { simple: true })), 17);
  const project1 = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get().id;
  const project2 = id('prj');
  const now = nowIso();
  db.prepare('INSERT INTO projects(id,name,slug,created_at) VALUES (?,?,?,?)')
    .run(project2, 'Other project', 'other-agent-boundary', now);
  const account1 = id('acc'), account2 = id('acc');
  db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'telegram',?,?,1,?,?)")
    .run(account1, 'Allowed account', encryptJson({ botToken: 'unreadable-social-secret-1' }), now, now);
  db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'vk',?,?,1,?,?)")
    .run(account2, 'Other account', encryptJson({ token: 'unreadable-social-secret-2' }), now, now);
  const source1 = id('src');
  db.prepare("INSERT INTO ingestion_connectors(id,type,name,config_json,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'google_drive','Authorized source','{}',?,1,?,?)")
    .run(source1, encryptJson({ serviceKey: 'connector-fixture-private-key' }), now, now);

  const first = createOwnerAgent({ name: 'Machine boundary 1', clientKind: 'n8n' }, 'a1b2b2-owner-one');
  const second = createOwnerAgent({ name: 'Machine boundary 2', clientKind: 'rest_client' }, 'a1b2b2-owner-two');
  const chatgpt = createOwnerAgent({ name: 'OAuth-only ChatGPT', clientKind: 'chatgpt' }, 'a1b2b2-owner-gpt');

  const firstGrant = updateOwnerAgentGrant(first.agentId, {
    expectedGrantVersion: 1, presetId: 'CUSTOM', publishMode: 'DRAFT_ONLY',
    scopeIds: ['projects:read', 'accounts:read', 'sources:read', 'posts:read'],
    projectIds: [project1], accountIds: [account1],
    sourceConnectorIds: [source1], confirmElevation: true
  }, 'a1b2b2-grant-one');
  assert.equal(firstGrant.grantVersion, 2);
  const secondGrant = updateOwnerAgentGrant(second.agentId, {
    expectedGrantVersion: 1, presetId: 'CUSTOM', publishMode: 'DRAFT_ONLY',
    scopeIds: ['projects:read'], projectIds: [project2], accountIds: [],
    sourceConnectorIds: [], confirmElevation: true
  }, 'a1b2b2-grant-two');
  assert.equal(secondGrant.grantVersion, 2);

  const keyEndpoint = agentId => '/api/owner/agents/' + agentId + '/machine-keys';
  async function issue(agentId, scopeIds, key) {
    const response = await send('POST', keyEndpoint(agentId), {
      expectedGrantVersion: 2, scopeIds, ttlHours: 24
    }, { ...owner, 'idempotency-key': key });
    assert.equal(response.statusCode, 201, response.body);
    assert.match(response.json().bearerToken, /^pak1_[A-Za-z0-9_-]{43}$/);
    return response.json();
  }
  const firstKey = await issue(first.agentId,
    ['projects:read', 'accounts:read', 'sources:read'], 'a1b2b2-first-token');
  const restrictedKey = await issue(first.agentId, ['projects:read'], 'a1b2b2-restricted-token');
  const secondKey = await issue(second.agentId, ['projects:read'], 'a1b2b2-second-token');

  assert.equal((await send('POST', keyEndpoint(chatgpt.agentId), {
    expectedGrantVersion: 1, scopeIds: ['projects:read'], ttlHours: 24
  }, { ...owner, 'idempotency-key': 'not-allowed-chatgpt' })).statusCode, 403);

  const originalAuditCount = eventCount();
  const knownGood = await send('GET', endpoint, undefined, readHeaders(firstKey.bearerToken));
  assert.equal(knownGood.statusCode, 200, knownGood.body);
  const capabilities = knownGood.json();
  assert.equal(capabilities.agentId, first.agentId);
  assert.equal(capabilities.grantVersion, 2);
  assert.equal(capabilities.presetId, 'CUSTOM');
  assert.equal(capabilities.publishMode, 'DRAFT_ONLY');
  assert.deepEqual(capabilities.scopeIds, ['accounts:read', 'projects:read', 'sources:read']);
  assert.deepEqual(capabilities.projectIds, [project1]);
  assert.deepEqual(capabilities.accountIds, [account1]);
  assert.deepEqual(capabilities.sourceConnectorIds, [source1]);
  assert.ok(capabilities.blockedReasons.includes('ONLY_PROJECT_AND_ACCOUNT_LIST_READ_ENABLED'));
  assert.ok(capabilities.blockedReasons.includes('MACHINE_KEYS_CANNOT_PUBLISH_OR_SCHEDULE'));
  assert.ok(!knownGood.body.includes(firstKey.bearerToken));
  assert.ok(!knownGood.body.includes(restrictedKey.bearerToken));
  assert.ok(!knownGood.body.includes('unreadable-social-secret'));
  assert.ok(!knownGood.body.includes('connector-fixture-private-key'));
  assert.equal(eventCount(), originalAuditCount, 'capabilities GET must not modify audit');

  const limited = await send('GET', endpoint, undefined, readHeaders(restrictedKey.bearerToken));
  assert.equal(limited.statusCode, 200, limited.body);
  assert.deepEqual(limited.json().scopeIds, ['projects:read']);
  assert.deepEqual(limited.json().projectIds, [project1]);
  assert.deepEqual(limited.json().accountIds, [], 'key without accounts:read must not list account IDs');
  assert.deepEqual(limited.json().sourceConnectorIds, [], 'key without sources:read must not list connector IDs');
  assert.equal(limited.json().agentId, first.agentId);

  const other = await send('GET', endpoint, undefined, readHeaders(secondKey.bearerToken));
  assert.equal(other.statusCode, 200, other.body);
  assert.equal(other.json().agentId, second.agentId);
  assert.deepEqual(other.json().projectIds, [project2]);
  assert.deepEqual(other.json().accountIds, []);
  assert.ok(!other.body.includes(project1), 'second agent must not discover the first project');
  assert.ok(!other.body.includes(account1), 'second agent must not discover the first account');

  for (const malformed of [
    {}, { cookie: owner.cookie }, { authorization: 'Bearer ' + session },
    { authorization: 'Bearer pk_' + 'a'.repeat(44) },
    { authorization: 'Bearer ' + process.env.APP_MASTER_KEY },
    { authorization: firstKey.bearerToken },
    { authorization: 'Bearer pak1_' + 'a'.repeat(43) },
    { authorization: 'Basic ' + firstKey.bearerToken },
    { authorization: 'Bearer ' + firstKey.bearerToken + ', Bearer fake' },
    { authorization: 'Bearer ' + firstKey.bearerToken, cookie: owner.cookie },
    { authorization: 'Bearer ' + firstKey.bearerToken, 'x-api-key': 'pk_legacy' },
    { authorization: 'Bearer ' + firstKey.bearerToken, 'x-integration-key': 'legacy' }
  ]) {
    const denied = await send('GET', endpoint, undefined, malformed);
    assert.equal(denied.statusCode, 401,
      'only one valid standalone machine Bearer may authorize capabilities');
    assert.equal(denied.json().error.code, 'UNAUTHORIZED');
    assert.match(String(denied.headers['www-authenticate']), /^Bearer /);
  }
  assert.equal((await send('GET', endpoint, undefined, {
    ...readHeaders(firstKey.bearerToken), origin: 'https://evil.example'
  })).statusCode, 403);
  assert.equal((await send('GET', endpoint, undefined, {
    ...readHeaders(firstKey.bearerToken), origin: 'null'
  })).statusCode, 403);
  for (const malformedOrigin of [
    owner.origin + '/path',
    owner.origin + '?query=1',
    owner.origin + '#fragment',
    'https://publisher.example.test@evil.example'
  ]) {
    assert.equal((await send('GET', endpoint, undefined, {
      ...readHeaders(firstKey.bearerToken), origin: malformedOrigin
    })).statusCode, 403, 'malformed Origin cannot be normalized into trust');
  }
  assert.equal((await send('GET', endpoint, undefined, {
    ...readHeaders(firstKey.bearerToken), origin: owner.origin
  })).statusCode, 200);

  const query = await send('GET', endpoint + '?access_token=untrusted', undefined,
    readHeaders(firstKey.bearerToken));
  assert.equal(query.statusCode, 400);
  assert.ok(!query.body.includes(firstKey.bearerToken));

  const unknownNoToken = await send('GET', '/api/agent/v1/not-implemented');
  assert.equal(unknownNoToken.statusCode, 401, 'even unknown agent routes must fail without machine auth');
  const unknownWithToken = await send('GET', '/api/agent/v1/not-implemented',
    undefined, readHeaders(firstKey.bearerToken));
  assert.equal(unknownWithToken.statusCode, 404, 'verified token cannot unlock unpublished route');
  const wrongMethod = await send('POST', endpoint, { action: 'publish' },
    readHeaders(firstKey.bearerToken));
  assert.equal(wrongMethod.statusCode, 404);
  const prefixSpoof = await send('GET', '/api/agent/v1malicious', undefined,
    readHeaders(firstKey.bearerToken));
  assert.equal(prefixSpoof.statusCode, 401, 'prefix collision is not part of the agent namespace');
  assert.equal((await send('GET', '/api/projects', undefined,
    readHeaders(firstKey.bearerToken))).statusCode, 401);
  assert.equal((await send('GET', '/api/owner/agents', undefined,
    readHeaders(firstKey.bearerToken))).statusCode, 401);
  assert.equal((await send('GET', '/api/integration/v1/drafts', undefined,
    readHeaders(firstKey.bearerToken))).statusCode, 401);
  assert.equal((await send('GET', '/mcp', undefined,
    readHeaders(firstKey.bearerToken))).statusCode, 404,
    'reserved MCP URL must not pretend to be an active transport');
  assert.equal(eventCount(), originalAuditCount, 'machine capability and deny paths must have no write effects');

  await app.close();
  app = await buildApp();
  const afterRestart = await send('GET', endpoint, undefined, readHeaders(firstKey.bearerToken));
  assert.equal(afterRestart.statusCode, 200, afterRestart.body);
  assert.deepEqual(afterRestart.json(), capabilities, 'capabilities must use DB state, not process cache');

  const expiredId = secondKey.machineKey.keyId;
  db.prepare('UPDATE agent_machine_keys SET expires_at=? WHERE id=?')
    .run('2000-01-01T00:00:00.000Z', expiredId);
  assert.equal((await send('GET', endpoint, undefined,
    readHeaders(secondKey.bearerToken))).statusCode, 401);

  const paused = controlOwnerAgent(first.agentId, 'pause',
    { expectedGrantVersion: 2, confirm: true }, 'a1b2b2-owner-pause');
  assert.equal(paused.status, 'PAUSED');
  assert.equal((await send('GET', endpoint, undefined,
    readHeaders(firstKey.bearerToken))).statusCode, 401);
  assert.equal((await send('GET', endpoint, undefined,
    readHeaders(restrictedKey.bearerToken))).statusCode, 401);

  console.log(JSON.stringify({
    ok: true, checkpoint: 'AGENT-A1b2b2', schema: 17,
    exactlyScopedCapabilities: true, bearerOnly: true, cookieAndLegacyIsolated: true,
    noOAuthOrMcp: true, unknownRouteProtected: true, noPostOrPublish: true,
    maliciousOriginDenied: true, noCredentialsInResponse: true,
    expiredAndPausedDenied: true, restartSafe: true
  }));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
