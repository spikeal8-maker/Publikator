/**
 * MCP-LOCAL-001: fake loopback REST → real official MCP stdio server/client.
 * Does not use production SQLite, provider credentials, Docker, real social APIs
 * or public network. Run: npm ci && npm test inside tools/local-mcp.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const serverFile = fileURLToPath(new URL('./server.mjs', import.meta.url));
const token = 'pk_' + 'F'.repeat(43);
const forbidden = 'PROVIDER_PRIVATE_SECRET_SHOULD_NOT_LEAK';
const startWithout = spawnSync(process.execPath, [serverFile], {
  env: { ...process.env, PUBLIKATOR_LOCAL_MCP_KEY: '', PUBLIKATOR_LOCAL_BASE_URL: 'http://127.0.0.1:8080' },
  encoding: 'utf8', timeout: 5_000
});
assert.equal(startWithout.status, 2, 'missing key must refuse to start');
assert.equal(startWithout.stdout, '', 'no startup text on MCP stdout');
assert.ok(!startWithout.stderr.includes(token), 'do not log token');

const startRemote = spawnSync(process.execPath, [serverFile], {
  env: { ...process.env, PUBLIKATOR_LOCAL_MCP_KEY: token, PUBLIKATOR_LOCAL_BASE_URL: 'https://example.org' },
  encoding: 'utf8', timeout: 5_000
});
assert.equal(startRemote.status, 2, 'non-loopback URL must refuse to start');
assert.equal(startRemote.stdout, '');

let nextId = 1;
const drafts = new Map();
const replayKeys = new Map();
const httpCalls = [];
const send = (res, code, payload) => {
  const content = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(content);
};

const http = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  httpCalls.push({ method: req.method, path: url.pathname, query: url.search,
    authOk: req.headers.authorization === 'Bearer ' + token,
    idempotencyKey: req.headers['idempotency-key'] ?? null });
  if (req.headers.authorization !== 'Bearer ' + token) return send(res, 401, {
    error: { code: 'UNAUTHORIZED', message: forbidden }
  });
  if (!url.pathname.startsWith('/api/integration/v1/drafts')) return send(res, 404, {
    error: { code: 'NOT_FOUND', message: forbidden }
  });

  if (req.method === 'GET' && url.pathname === '/api/integration/v1/drafts') {
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isInteger(offset) || offset < 0) return send(res, 400, {
      error: { code: 'VALIDATION_ERROR', message: forbidden }
    });
    const all = [...drafts.values()];
    return send(res, 200, {
      items: all.slice(offset, offset + limit), limit, offset,
      total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null
    });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/integration/v1/drafts/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/integration/v1/drafts/'.length));
    const item = drafts.get(id);
    if (!item) return send(res, 404, { error: { code: 'NOT_FOUND', message: forbidden } });
    return send(res, 200, item);
  }
  if (req.method === 'POST' && url.pathname === '/api/integration/v1/drafts') {
    let body = '';
    for await (const part of req) {
      body += part.toString('utf8');
      if (body.length > 24_000) return send(res, 413, { error: { code: 'BODY_TOO_LARGE' } });
    }
    let payload;
    try { payload = JSON.parse(body); } catch { return send(res, 400, { error: { code: 'BAD_JSON' } }); }
    const idem = req.headers['idempotency-key'];
    assert.match(String(idem || ''), /^[A-Za-z0-9._:-]{1,128}$/);
    assert.deepEqual(payload.targets, []);
    assert.deepEqual(payload.schedule, { mode: 'MANUAL' });
    assert.equal(payload.contentFormat, 'TEXT_ONLY');
    assert.equal(payload.publicationKind, 'FEED');
    assert.equal(payload.externalId, idem);
    assert.ok(typeof payload.body === 'string' && payload.body.length > 0);

    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (replayKeys.has(idem)) {
      const existing = replayKeys.get(idem);
      if (existing.hash !== hash) return send(res, 409, {
        error: { code: 'IDEMPOTENCY_CONFLICT', message: forbidden }
      });
      return send(res, 200, { replay: true, post: drafts.get(existing.id) });
    }
    const id = 'post_12345678-1234-1234-1234-' + String(nextId++).padStart(12, '0');
    const post = {
      id, project: payload.project, internalTitle: payload.internalTitle, body: payload.body,
      publicationStatus: 'DRAFT', contentFormat: 'TEXT_ONLY', contentVersion: 1,
      // Future/hostile optional fields must NOT escape the MCP DTO allowlist.
      credentials_encrypted: forbidden, access_token: forbidden
    };
    drafts.set(id, post);
    replayKeys.set(idem, { id, hash });
    return send(res, 201, { replay: false, post });
  }
  return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: forbidden } });
});

http.listen(0, '127.0.0.1');
await once(http, 'listening');
const address = http.address();
assert.ok(address && typeof address === 'object');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverFile],
  env: { ...process.env, PUBLIKATOR_LOCAL_MCP_KEY: token,
    PUBLIKATOR_LOCAL_BASE_URL: 'http://127.0.0.1:' + address.port },
  stderr: 'pipe'
});
const client = new Client({ name: 'publikator-mcp-local-acceptance', version: '0.1.0' });
const call = async (name, args) => client.callTool({ name, arguments: args });
let checks = 2;

try {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.deepEqual(catalog.tools.map(x => x.name).sort(), [
    'create_text_draft', 'get_connection_status', 'get_draft', 'list_drafts'
  ]);
  assert.ok(catalog.tools.every(x => !/publish|schedule|media|secrets|credentials|delete/i.test(x.name)));
  checks++;

  const health = await call('get_connection_status', {});
  assert.equal(Boolean(health.isError), false);
  assert.equal(health.structuredContent?.connected, true);
  assert.equal(health.structuredContent?.canPublish, false);
  checks++;

  const initial = await call('list_drafts', { limit: 5, offset: 0 });
  assert.equal(initial.structuredContent?.total, 0);
  checks++;

  const input = {
    projectSlug: 'asa-telegram-max',
    title: 'Технический тест MCP',
    body: 'Тестовый черновик без публикации и получателей.',
    idempotencyKey: 'MCP-LOCAL-001-TEST-1'
  };
  const created = await call('create_text_draft', input);
  assert.equal(Boolean(created.isError), false);
  assert.equal(created.structuredContent?.replay, false);
  assert.equal(created.structuredContent?.post?.publicationStatus, 'DRAFT');
  assert.equal(created.structuredContent?.post?.body, input.body);
  const id = created.structuredContent.post.id;
  checks++;

  const again = await call('create_text_draft', input);
  assert.equal(Boolean(again.isError), false);
  assert.equal(again.structuredContent?.replay, true);
  assert.equal(again.structuredContent?.post?.id, id);
  assert.equal(drafts.size, 1);
  checks++;

  const fetched = await call('get_draft', { postId: id });
  assert.equal(Boolean(fetched.isError), false);
  assert.equal(fetched.structuredContent?.id, id);
  assert.equal(JSON.stringify(fetched).includes(forbidden), false);
  checks++;

  const listed = await call('list_drafts', { limit: 1, offset: 0 });
  assert.equal(listed.structuredContent?.total, 1);
  assert.equal(listed.structuredContent?.items?.[0]?.id, id);
  assert.equal(JSON.stringify(listed).includes(forbidden), false);
  checks++;

  const notFound = await call('get_draft', { postId: 'post_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  assert.equal(notFound.isError, true);
  assert.ok(JSON.stringify(notFound).includes('LOCAL_API_REJECTED_NOT_FOUND'));
  assert.ok(!JSON.stringify(notFound).includes(forbidden));
  checks++;

  const changed = await call('create_text_draft', { ...input, body: 'Different body' });
  assert.equal(changed.isError, true);
  assert.ok(JSON.stringify(changed).includes('LOCAL_API_REJECTED_IDEMPOTENCY_CONFLICT'));
  assert.equal(drafts.size, 1);
  checks++;

  const before = httpCalls.length;
  // MCP SDK either returns tool validation isError or rejects invalid tool args;
  // in both cases the remote REST API MUST NOT see them.
  try { await call('create_text_draft', { ...input, projectSlug: 'https://evil.example' }); }
  catch { /* acceptable SDK rejection */ }
  assert.equal(httpCalls.length, before, 'invalid tool argument reached REST server');
  checks++;

  const pre = httpCalls.length;
  try { await call('publish_now', { postId: id }); }
  catch { /* tool missing is expected */ }
  assert.equal(httpCalls.length, pre, 'unknown publish tool reached REST server');
  checks++;

  assert.ok(httpCalls.every(x =>
    x.authOk && x.path.startsWith('/api/integration/v1/drafts') &&
    !/publish|ready|accounts|social|schedule/.test(x.path)));
  checks++;

  console.log(JSON.stringify({
    ok: true, checkpoint: 'MCP-LOCAL-001', checks,
    protocol: 'MCP SDK v2 stdio', tools: catalog.tools.map(t => t.name).sort(),
    idempotencyReplay: true, errorRedaction: true, noPublicSend: true,
    unauthorizedToolsAbsent: true, draftCount: drafts.size
  }));
} finally {
  await client.close().catch(() => {});
  await new Promise(resolve => http.close(resolve));
}
