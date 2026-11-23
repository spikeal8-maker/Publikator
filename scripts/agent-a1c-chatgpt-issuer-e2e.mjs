import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const reservation = net.createServer().listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = 'http://127.0.0.1:' + port;
const resource = origin + '/mcp/chatgpt';
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
const { beginMaintenance } = await import('../dist/runtime-gate.js');
const { encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
const { clearRestoredOAuthSessions } = await import('../dist/http/agent-oauth.js');
let app;
let browser;
try {
  migrate();
  const stamp = nowIso();
  const password = 'chatgpt-issuer-fixture-owner-password';
  createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'), 'owner', password, password);
  db.prepare("INSERT INTO agent_principals(id,name,client_kind,created_at,updated_at) VALUES(?,?,'chatgpt',?,?)")
    .run(agentId, 'Sample ChatGPT integration', stamp, stamp);
  const projectId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  const accountId = 'acc_oauth_mcp_fixture';
  const deniedAccount = 'acc_oauth_mcp_hidden';
  const canary = 'mcp-fixture-credential-canary';
  const scopes = ['accounts:read', 'posts:read', 'posts:write', 'projects:read'];
  for (const id of [accountId, deniedAccount]) {
    db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'telegram',?,?,1,?,?)")
      .run(id, id, encryptJson({ botToken: canary, chatId: '@fixture' }), stamp, stamp);
  }
  db.prepare('INSERT INTO agent_grants(agent_id,scope_ids_json,project_ids_json,account_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(agentId, JSON.stringify(scopes), JSON.stringify([projectId]), JSON.stringify([accountId]), stamp, stamp);
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
  assert.deepEqual((await json('/.well-known/oauth-protected-resource/mcp/chatgpt')).authorization_servers, [origin]);
  const { keys } = await json('/oauth/jwks');
  assert.ok(keys.length && keys.every((key) => !key.d));

  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: callback, resource, state,
    scope: ['offline_access', 'publish:request', ...scopes].join(' '), prompt: 'consent',
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
      assert.ok(!html.includes('publish:request'));
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
  assert.deepEqual(tokens.scope.split(' ').sort(), scopes);

  const saved = JSON.stringify(db.prepare('SELECT * FROM agent_oauth_artifacts').all());
  assert.ok(!saved.includes(tokens.access_token));
  assert.ok(!saved.includes(tokens.refresh_token));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const browserLogin = await context.request.post(origin + '/api/auth/login', {
    data: { username: 'owner', password }, headers: { Origin: origin },
  });
  assert.equal(browserLogin.status(), 200);
  const page = await context.newPage();
  await page.route(callback + '?**', (route) => route.fulfill({ status: 200, body: 'Fixture callback' }));
  await page.goto(metadata.authorization_endpoint + '?' + query);
  for (let step = 0; step < 2; step += 1) {
    const posted = page.waitForRequest((request) =>
      request.method() === 'POST' && request.url().includes('/oauth/interaction/'));
    await page.getByRole('button', { name: 'Разрешить' }).click();
    assert.equal((await (await posted).allHeaders()).origin, origin);
  }
  await page.waitForURL(callback + '?**');
  assert.ok(new URL(page.url()).searchParams.get('code'));

  const initialize = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } },
  };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const missing = await fetch(resource, { method: 'POST', headers, body: JSON.stringify(initialize) });
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate'), /oauth-protected-resource\/mcp\/chatgpt/);
  await missing.body?.cancel();
  const bearer = 'Bearer ' + tokens.access_token;
  const client = new Client({ name: 'issuer-mcp-fixture', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { Authorization: bearer } },
  }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'publikator_create_text_draft', 'publikator_edit_text_draft', 'publikator_get_text_draft',
      'publikator_list_accounts', 'publikator_list_projects', 'publikator_list_text_drafts',
    ]);
    const projects = await client.callTool({ name: 'publikator_list_projects', arguments: {} });
    assert.equal(JSON.parse(projects.content[0].text).items[0].id, projectId);
    const accounts = await client.callTool({ name: 'publikator_list_accounts', arguments: {} });
    assert.deepEqual(JSON.parse(accounts.content[0].text).items.map((account) => account.id), [accountId]);
    assert.ok(!JSON.stringify(accounts).includes(canary));
    const args = {
      projectId, internalTitle: 'MCP draft fixture', bodyPlain: 'Fixture text.',
      targetAccountIds: [accountId], idempotencyKey: 'test-mcp-draft',
    };
    const before = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
    const denied = await client.callTool({ name: 'publikator_create_text_draft',
      arguments: { ...args, targetAccountIds: [deniedAccount] } });
    assert.equal(denied.isError, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, before);
    const release = beginMaintenance('MCP maintenance fixture');
    try {
      const blocked = await client.callTool({ name: 'publikator_create_text_draft', arguments: args });
      assert.equal(blocked.isError, true);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, before);
    } finally {
      release();
    }
    const created = await client.callTool({ name: 'publikator_create_text_draft', arguments: args });
    assert.ok(!created.isError);
    const doc = JSON.parse(created.content[0].text);
    assert.equal(doc.status, 'DRAFT');
    const replay = await client.callTool({ name: 'publikator_create_text_draft', arguments: args });
    assert.equal(JSON.parse(replay.content[0].text).postId, doc.postId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, before + 1);
    assert.equal(db.prepare('SELECT origin FROM agent_activity_events WHERE post_id=?').get(doc.postId).origin, 'MCP');
    const listed = await client.callTool({ name: 'publikator_list_text_drafts', arguments: {} });
    assert.deepEqual(JSON.parse(listed.content[0].text).items.map((item) => item.postId), [doc.postId]);
    const invisible = await client.callTool({ name: 'publikator_get_text_draft', arguments: { postId: 'unrelated' } });
    assert.equal(invisible.isError, true);
    const read = await client.callTool({ name: 'publikator_get_text_draft', arguments: { postId: doc.postId } });
    assert.equal(JSON.parse(read.content[0].text).bodyPlain, args.bodyPlain);
    const revision = {
      postId: doc.postId, expectedContentVersion: doc.contentVersion,
      bodyPlain: 'Исправленный текст.', idempotencyKey: 'test-mcp-edit',
    };
    const edit = await client.callTool({ name: 'publikator_edit_text_draft', arguments: revision });
    const edited = JSON.parse(edit.content[0].text);
    assert.equal(edited.status, 'DRAFT');
    assert.equal(edited.bodyPlain, revision.bodyPlain);
    assert.equal(edited.contentVersion, doc.contentVersion + 1);
    const conflict = await client.callTool({ name: 'publikator_edit_text_draft',
      arguments: { ...revision, idempotencyKey: 'test-mcp-stale-edit' } });
    assert.equal(conflict.isError, true);
    const editReplay = await client.callTool({ name: 'publikator_edit_text_draft', arguments: revision });
    assert.equal(JSON.parse(editReplay.content[0].text).contentVersion, edited.contentVersion);
    const origins = db.prepare('SELECT DISTINCT origin FROM agent_activity_events WHERE post_id=?').all(doc.postId);
    assert.deepEqual(origins.map((event) => event.origin), ['MCP']);
  } finally {
    await client.close();
  }
  await page.goto(origin + '/assistant.html');
  await page.locator('#settings-open').click();
  await page.getByRole('button', { name: 'Проверить адрес', exact: true }).click();
  await page.getByText('Адрес доступен и запрашивает OAuth.', { exact: false }).waitFor();
  await page.getByText('Управлять доступом ChatGPT', { exact: true }).click();
  const form = page.locator('#chatgpt-grant-form');
  await form.waitFor({ state: 'visible' });
  await form.getByText('Создавать и редактировать текстовые черновики', { exact: true }).click();
  await form.getByLabel('Подтверждаю выбранные права').check();
  const savedGrant = page.waitForResponse((response) =>
    response.request().method() === 'PUT' && response.url().endsWith('/grant'));
  await form.getByRole('button', { name: 'Сохранить права' }).click();
  assert.equal((await savedGrant).status(), 200);
  const nextScopes = db.prepare('SELECT scope_ids_json FROM agent_grants WHERE agent_id=?').get(agentId);
  assert.deepEqual(JSON.parse(nextScopes.scope_ids_json).sort(), ['accounts:read', 'posts:read', 'projects:read']);
  const revoked = await fetch(resource, { method: 'POST',
    headers: { ...headers, Authorization: bearer }, body: JSON.stringify(initialize) });
  assert.equal(revoked.status, 401);
  await revoked.body?.cancel();

  const relink = new URLSearchParams(query);
  relink.delete('prompt');
  relink.set('state', randomBytes(16).toString('base64url'));
  await page.goto(metadata.authorization_endpoint + '?' + relink);
  await page.getByRole('button', { name: 'Разрешить' }).waitFor();
  assert.ok(page.url().includes('/oauth/interaction/'));
  assert.ok(!(await page.locator('body').innerText()).includes('posts:write'));
  await context.close();

  clearRestoredOAuthSessions();
  const afterRestore = db.prepare('SELECT model FROM agent_oauth_artifacts').all().map((row) => row.model);
  assert.deepEqual(afterRestore, ['PublikatorOAuthSigningKey']);
  console.log('ChatGPT issuer, owner consent, scope intersection and restore invalidation PASS');
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  db.close();
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
