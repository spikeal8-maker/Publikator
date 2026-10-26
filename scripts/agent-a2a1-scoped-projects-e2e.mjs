import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-agent-a2a1-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = 'agent-project-read-test-master-key-not-a-token-2026';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
const { createAdminSetupGrant, createOrRecoverAdmin } = await import('../dist/admin-auth.js');
const { createOwnerAgent, controlOwnerAgent } = await import('../dist/agent-owner-registry.js');
const { updateOwnerAgentGrant } = await import('../dist/agent-owner-grants.js');
const { issueOwnerMachineKey } = await import('../dist/agent-machine-keys.js');

migrate();
let app = await buildApp();
const ownerToken = createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'),
  'project_owner', 'project-read-owner-password-2026', 'project-read-owner-password-2026');
const endpoint = '/api/agent/v1/projects';
const bearer = token => ({ authorization: 'Bearer ' + token });
async function get(url, headers = {}) {
  return app.inject({ method: 'GET', url, headers });
}
function count(table) {
  return db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}

try {
  const timestamp = nowIso();
  const originalProject = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get().id;
  const p2 = id('prj'), p3 = id('prj'), foreign = id('prj');
  for (const [projectId, slug, title] of [
    [p2, 'second', 'Second authorized project'],
    [p3, 'third', 'Third authorized project'],
    [foreign, 'foreign', 'Foreign project']
  ]) {
    db.prepare('INSERT INTO projects(id,name,slug,default_timezone,created_at) VALUES (?,?,?,?,?)')
      .run(projectId, title, slug, 'Europe/Moscow', timestamp);
  }

  const a = createOwnerAgent({ name: 'Machine projects A', clientKind: 'n8n' }, 'a2a-owner-a');
  const b = createOwnerAgent({ name: 'Machine projects B', clientKind: 'rest_client' }, 'a2a-owner-b');
  const c = createOwnerAgent({ name: 'Machine no projects scope', clientKind: 'n8n' }, 'a2a-owner-c');
  const d = createOwnerAgent({ name: 'Machine empty resources', clientKind: 'n8n' }, 'a2a-owner-d');
  function grant(agentId, scopes, projectIds, key) {
    const saved = updateOwnerAgentGrant(agentId, {
      expectedGrantVersion: 1, presetId: 'CUSTOM', publishMode: 'DRAFT_ONLY',
      scopeIds: scopes, projectIds,
      accountIds: [], sourceConnectorIds: [], confirmElevation: true
    }, key);
    assert.equal(saved.grantVersion, 2);
    return saved;
  }
  grant(a.agentId, ['projects:read'], [originalProject, p2, p3], 'a2a-grant-a');
  grant(b.agentId, ['projects:read'], [foreign], 'a2a-grant-b');
  grant(c.agentId, ['posts:read'], [originalProject], 'a2a-grant-c');
  grant(d.agentId, ['projects:read'], [], 'a2a-grant-d');

  function machineToken(agentId, scopes, key, grantVersion = 2) {
    const created = issueOwnerMachineKey(agentId, {
      expectedGrantVersion: grantVersion, scopeIds: scopes, ttlHours: 24
    }, key);
    assert.match(created.bearerToken, /^pak1_[A-Za-z0-9_-]{43}$/);
    return created.bearerToken;
  }
  const tokenA = machineToken(a.agentId, ['projects:read'], 'a2a-key-a');
  const tokenB = machineToken(b.agentId, ['projects:read'], 'a2a-key-b');
  const tokenC = machineToken(c.agentId, ['posts:read'], 'a2a-key-c');
  const tokenD = machineToken(d.agentId, ['projects:read'], 'a2a-key-d');
  const eventsBefore = count('agent_activity_events');

  const first = await get(endpoint, bearer(tokenA));
  assert.equal(first.statusCode, 200, first.body);
  const available = [originalProject, p2, p3].sort();
  assert.deepEqual(first.json().items.map(x => x.id), available);
  assert.equal(first.json().pagination.limit, 50);
  assert.equal(first.json().pagination.nextCursor, null);
  assert.ok(first.json().items.every(x =>
    typeof x.name === 'string' && typeof x.defaultTimezone === 'string'));
  assert.ok(!first.body.includes('foreign'));
  assert.ok(!first.body.includes(foreign));
  assert.ok(!first.body.includes(ownerToken));
  assert.ok(!first.body.includes(tokenA));

  const other = await get(endpoint, bearer(tokenB));
  assert.equal(other.statusCode, 200, other.body);
  assert.deepEqual(other.json().items.map(x=>x.id), [foreign]);
  assert.ok(!other.body.includes(originalProject));
  assert.ok(!other.body.includes(p2));
  assert.ok(!other.body.includes(p3));

  const empty = await get(endpoint, bearer(tokenD));
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json().items, []);
  assert.equal(empty.json().pagination.nextCursor, null);
  const denied = await get(endpoint, bearer(tokenC));
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().error.code, 'FORBIDDEN_SCOPE');

  const visited = [];
  let cursor = null;
  for (let i=0;i<3;i++) {
    const url = endpoint + '?limit=1' + (cursor ? '&cursor=' + cursor : '');
    const response = await get(url, bearer(tokenA));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().items.length, 1);
    visited.push(response.json().items[0].id);
    cursor = response.json().pagination.nextCursor;
    if(i<2)assert.ok(cursor);
    else assert.equal(cursor,null);
  }
  assert.deepEqual(visited,available, 'cursor must page through exact allowlist in stable order');
  const invalidQueries = [
    '?limit=0','?limit=101','?limit=-1','?limit=1.0','?limit=foo',
    '?cursor=***','?cursor=' + Buffer.from("' OR 1=1 --").toString('base64url'),
    '?cursor=a','?extra=foreign','?limit=2&other=true'
  ];
  for (const query of invalidQueries) {
    const response = await get(endpoint+query,bearer(tokenA));
    assert.equal(response.statusCode, 400, 'reject invalid pagination: '+query);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }
  const forgedCursor = Buffer.from(foreign).toString('base64url');
  const forgedPage = await get(endpoint+'?cursor='+forgedCursor,bearer(tokenA));
  assert.equal(forgedPage.statusCode, 200);
  assert.ok(!forgedPage.body.includes(foreign),'cursor must not expand resource membership');

  for (const [headers, expected] of [
    [{},401],
    [{cookie:'publikator_session='+ownerToken},401],
    [{authorization:'Bearer '+ownerToken},401],
    [{authorization:'Bearer pk_'+'x'.repeat(43)},401],
    [{authorization:'Bearer '+tokenA,cookie:'publikator_session='+ownerToken},401],
    [{authorization:'Bearer '+tokenA,origin:'https://attacker.example'},403]
  ]) {
    assert.equal((await get(endpoint,headers)).statusCode,expected);
  }
  assert.equal((await get(endpoint,{...bearer(tokenA),origin:process.env.PUBLIC_BASE_URL})).statusCode,200);
  assert.equal((await get('/api/agent/v1/accounts',bearer(tokenA))).statusCode,403,
    'account route exists but project-only token lacks accounts:read');
  assert.equal((await get('/api/agent/v1/posts',bearer(tokenA))).statusCode,404);
  assert.equal((await get('/api/projects',bearer(tokenA))).statusCode,401);
  assert.equal(count('agent_activity_events'),eventsBefore,
    'agent project list is a safe read and cannot enqueue posts or fabricate events');

  await app.close();
  app = await buildApp();
  const restarted = await get(endpoint,bearer(tokenA));
  assert.equal(restarted.statusCode,200,restarted.body);
  assert.deepEqual(restarted.json(),first.json(),'read results are based on persistent grant/DB state');

  // Removing a project from owner permissions invalidates the old token.
  const newGrant = updateOwnerAgentGrant(a.agentId, {
    expectedGrantVersion: 2, presetId: 'CUSTOM', publishMode: 'DRAFT_ONLY',
    scopeIds: ['projects:read'], projectIds: [originalProject, p2],
    accountIds: [], sourceConnectorIds: [], confirmElevation: false
  }, 'a2a-narrow-grant');
  assert.equal(newGrant.grantVersion,3);
  assert.equal((await get(endpoint,bearer(tokenA))).statusCode,401,
    'old grantVersion cannot carry resource authorization');
  const tokenA2=machineToken(a.agentId,['projects:read'],'a2a-new-token',3);
  const narrowed=await get(endpoint,bearer(tokenA2));
  assert.equal(narrowed.statusCode,200,narrowed.body);
  assert.deepEqual(narrowed.json().items.map(x=>x.id),[originalProject,p2].sort());
  assert.ok(!narrowed.body.includes(p3));

  // A stale allowlist reference to a deleted resource is never emitted.
  db.prepare('DELETE FROM projects WHERE id=?').run(p2);
  const afterDeletion=await get(endpoint,bearer(tokenA2));
  assert.equal(afterDeletion.statusCode,200,afterDeletion.body);
  assert.deepEqual(afterDeletion.json().items.map(x=>x.id),[originalProject]);

  controlOwnerAgent(a.agentId,'pause',{expectedGrantVersion:3,confirm:true},'a2a-pause');
  assert.equal((await get(endpoint,bearer(tokenA2))).statusCode,401);
  db.prepare('UPDATE agent_machine_keys SET expires_at=? WHERE token_hash=(SELECT token_hash FROM agent_machine_keys WHERE agent_id=? AND revoked_at IS NULL LIMIT 1)')
    .run('2000-01-01T00:00:00.000Z',b.agentId);
  assert.equal((await get(endpoint,bearer(tokenB))).statusCode,401);

  console.log(JSON.stringify({
    ok:true,checkpoint:'AGENT-A2a1',
    ownerAllowlistSqlFiltering:true,scopeAndCurrentGrant:true,
    cursorStable:true,unknownCursorCannotBypass:true,deletedResourcesOmitted:true,
    crossAgentProjectIsolation:true,legacyCookieDenied:true,
    staleAndPausedKeysDenied:true,noWritesOrExternalPosts:true,restartSafe:true
  }));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}
