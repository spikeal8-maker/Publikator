import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const reservation = net.createServer().listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = 'http://127.0.0.1:' + port;
const resource = origin + '/mcp';
const callback = origin + '/oauth-test-callback';
const clientId = 'test-static-client';
const clientSecret = randomBytes(32).toString('base64url');
const agentId = 'chatgpt-oauth-fixture';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-chatgpt-issuer-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: directory, PUBLIC_BASE_URL: origin,
  APP_MASTER_KEY: 'chatgpt-issuer-acceptance-fixture-secret-key',
  PUBLIKATOR_CHATGPT_OAUTH_CLIENT_ID: clientId,
  PUBLIKATOR_CHATGPT_OAUTH_CLIENT_SECRET: clientSecret,
  PUBLIKATOR_CHATGPT_AGENT_ID: agentId,
  PUBLIKATOR_CHATGPT_OAUTH_REDIRECT_URI: callback,
});
delete process.env.ADMIN_PASSWORD;

const { db, migrate, nowIso } = await import('../dist/db.js');
const { createAdminSetupGrant, createOrRecoverAdmin, loginAdmin } = await import('../dist/admin-auth.js');
const { buildApp } = await import('../dist/app.js');
const { clearRestoredOAuthSessions } = await import('../dist/http/agent-oauth.js');
let app;
try {
  migrate();
  const stamp = nowIso();
  const password = 'chatgpt-issuer-fixture-owner-password';
  createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'), 'owner', password, password);
  db.prepare("INSERT INTO agent_principals(id,name,client_kind,created_at,updated_at) VALUES(?,?,'chatgpt',?,?)")
    .run(agentId, 'Sample ChatGPT integration', stamp, stamp);
  db.prepare('INSERT INTO agent_grants(agent_id,scope_ids_json,created_at,updated_at) VALUES(?,?,?,?)')
    .run(agentId, JSON.stringify(['projects:read']), stamp, stamp);
  const owner = loginAdmin('owner', password);
  assert.ok(owner);
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port });

  async function json(address) {
    const response = await fetch(origin + address);
    assert.equal(response.status, 200);
    return response.json();
  }

  const metadata = await json('/.well-known/oauth-authorization-server');
  assert.equal(metadata.issuer, origin);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.deepEqual((await json('/.well-known/oauth-protected-resource/mcp')).authorization_servers, [origin]);
  const { keys } = await json('/oauth/jwks');
  assert.ok(keys.length && keys.every((key) => !key.d));

  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: callback, resource, state,
    scope: 'offline_access projects:read posts:write', prompt: 'consent',
    code_challenge_method: 'S256', code_challenge: challenge,
  });
  let destination = new URL(metadata.authorization_endpoint + '?' + query);
  const cookies = new Map();
  let code;
  let approved = 0;
  let blocked = false;
  const cookiesAt = (url) => [...cookies.values()]
    .filter(({ path }) => url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : path + '/'))
    .map(({ pair }) => pair).join('; ');
  function storeCookies(response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...tail] = cookie.split('; ');
      const path = tail.find((part) => /^path=/i.test(part))?.slice(5) ?? '/';
      const eq = pair.indexOf('=');
      const key = pair.slice(0, eq) + ' ' + path;
      if (pair.slice(eq + 1)) cookies.set(key, { pair, path });
      else cookies.delete(key);
    }
  }

  for (let hop = 0; hop < 9; hop += 1) {
    const cookie = cookiesAt(destination);
    let result;
    if (destination.pathname.startsWith('/oauth/interaction/')) {
      if (!blocked) {
        const untrusted = await fetch(destination, { method: 'POST',
          headers: { Cookie: cookie, Origin: origin },
          body: new URLSearchParams({ grant: '1.1', decision: 'allow' }),
        });
        assert.equal(untrusted.status, 403);
        await untrusted.body?.cancel();
        blocked = true;
      }
      const ownerCookie = [cookie, 'publikator_session=' + owner].filter(Boolean).join('; ');
      const form = await fetch(destination, { headers: { Cookie: ownerCookie } });
      assert.equal(form.status, 200);
      const html = await form.text();
      assert.ok(html.includes('projects:read'));
      assert.ok(!html.includes('posts:write'));
      const version = /name="grant" value="([0-9.]+)"/.exec(html)?.[1];
      assert.equal(version, '1.1');
      const stale = await fetch(destination, { method: 'POST', redirect: 'manual',
        headers: { Cookie: ownerCookie, Origin: origin },
        body: new URLSearchParams({ grant: '99.99', decision: 'allow' }),
      });
      assert.equal(stale.status, 409);
      await stale.body?.cancel();
      const crossOrigin = await fetch(destination, { method: 'POST', redirect: 'manual',
        headers: { Cookie: ownerCookie, Origin: 'https://untrusted.invalid' },
        body: new URLSearchParams({ grant: version, decision: 'allow' }),
      });
      assert.equal(crossOrigin.status, 403);
      await crossOrigin.body?.cancel();
      result = await fetch(destination, {
        method: 'POST', redirect: 'manual', headers: { Cookie: ownerCookie, Origin: origin },
        body: new URLSearchParams({ grant: version, decision: 'allow' }),
      });
      approved += 1;
    } else {
      result = await fetch(destination, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : undefined });
    }
    storeCookies(result);
    const next = result.headers.get('location');
    if (!next) {
      const detail = (await result.text()).replaceAll(/<[^>]+>/g, ' ').replaceAll(/\s+/g, ' ');
      assert.fail('Expected redirect from ' + destination.pathname + ', received ' + result.status + ' ' + detail.slice(-450));
    }
    await result.body?.cancel();
    destination = new URL(next, destination);
    assert.equal(destination.origin, origin);
    if (destination.href.startsWith(callback + '?')) {
      assert.equal(destination.searchParams.get('state'), state);
      assert.equal(destination.searchParams.get('iss'), origin);
      code = destination.searchParams.get('code');
      break;
    }
  }
  assert.ok(code);
  assert.equal(approved, 2);

  const grant = await fetch(metadata.token_endpoint, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
      client_secret: clientSecret, code, code_verifier: verifier, resource, redirect_uri: callback }),
  });
  const tokens = await grant.json();
  assert.equal(grant.status, 200, tokens.error_description);
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  assert.equal(tokens.scope, 'projects:read');

  const saved = JSON.stringify(db.prepare('SELECT * FROM agent_oauth_artifacts').all());
  assert.ok(!saved.includes(tokens.access_token));
  assert.ok(!saved.includes(tokens.refresh_token));
  clearRestoredOAuthSessions();
  const afterRestore = db.prepare('SELECT model FROM agent_oauth_artifacts').all().map((row) => row.model);
  assert.deepEqual(afterRestore, ['PublikatorOAuthSigningKey']);
  console.log('ChatGPT issuer, owner consent, scope intersection and restore invalidation PASS');
} finally {
  if (app) await app.close();
  db.close();
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
