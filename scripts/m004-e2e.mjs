import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-m0-004-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'm0-004-security-password';
process.env.APP_MASTER_KEY = 'm0-004-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate } = await import('../dist/db.js');
const security = await import('../dist/ingestion-security.js');
const integration = await import('../dist/integration-security.js');

migrate();
assert.equal(Number(db.pragma('user_version', { simple: true })), 6);
for (const table of ['integration_api_keys', 'ingestion_connectors']) {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
}

function expectThrow(fn, pattern) {
  assert.throws(fn, pattern);
}

try {  const safePaths = security.validateBundleEntries([
    { path: 'content.xlsx', kind: 'file', compressedSize: 100, expandedSize: 200 },
    { path: 'media/post-1__01.jpg', kind: 'file', compressedSize: 1000, expandedSize: 1500 },
    { path: 'media', kind: 'directory', compressedSize: 0, expandedSize: 0 }
  ]);
  assert.deepEqual(safePaths, ['content.xlsx', 'media/post-1__01.jpg', 'media']);
  expectThrow(() => security.validateBundleEntries([{ path: '../escape.txt', kind: 'file', compressedSize: 1, expandedSize: 1 }]), /traversal/i);
  expectThrow(() => security.validateBundleEntries([{ path: 'C:\\evil.txt', kind: 'file', compressedSize: 1, expandedSize: 1 }]), /unsafe|relative/i);
  expectThrow(() => security.validateBundleEntries([{ path: 'media/link', kind: 'symlink', compressedSize: 1, expandedSize: 1 }]), /forbidden/i);
  expectThrow(() => security.validateBundleEntries([{ path: 'media/CON', kind: 'file', compressedSize: 1, expandedSize: 1 }]), /device/i);
  expectThrow(() => security.validateBundleEntries([{ path: 'bomb.bin', kind: 'file', compressedSize: 1, expandedSize: 1000 }], {
    ...security.DEFAULT_BUNDLE_LIMITS,
    maxCompressionRatio: 10
  }), /compression-ratio/i);

  const publicResolver = async () => ['93.184.216.34'];
  const privateResolver = async () => ['127.0.0.1'];
  await security.validateRemoteMediaUrl('https://example.test/image.png', publicResolver);
  assert.equal(security.isBlockedIngestionIp('::ffff:127.0.0.1'), true);
  assert.equal(security.isBlockedIngestionIp('2606:4700:4700::1111'), false);
  await assert.rejects(() => security.validateRemoteMediaUrl('http://example.test/image.png', publicResolver), /HTTPS/i);
  await assert.rejects(() => security.validateRemoteMediaUrl('https://internal.test/x', privateResolver), /blocked/i);
  await assert.rejects(() => security.validateRemoteMediaUrl('https://user:pass@example.test/x', publicResolver), /credentials/i);  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x00]);
  const okFetch = async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  const savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  await assert.rejects(() => security.fetchRemoteMedia('https://example.test/image.png', { resolver: publicResolver, fetchImpl: okFetch }), /test-only/i);
  process.env.NODE_ENV = savedNodeEnv;
  const fetched = await security.fetchRemoteMedia('https://example.test/image.png', { resolver: publicResolver, fetchImpl: okFetch });
  assert.equal(fetched.mimeType, 'image/png');
  assert.deepEqual(fetched.buffer, png);

  let pinnedOptions = null;
  const fakeRequest = (options, callback) => {
    pinnedOptions = options;
    const request = new EventEmitter();
    request.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'image/png', 'content-length': String(png.length) };
      response.resume = () => undefined;
      callback(response); response.emit('data', png); response.emit('end'); request.emit('close');
    });
    request.destroy = (error) => process.nextTick(() => { if (error) request.emit('error', error); request.emit('close'); });
    return request;
  };
  const pinned = await security.fetchRemoteMedia('https://example.test/image.png', { resolver: publicResolver, requestImpl: fakeRequest });
  assert.equal(pinned.mimeType, 'image/png');
  assert.equal(pinnedOptions.hostname, '93.184.216.34');
  assert.equal(pinnedOptions.servername, 'example.test');
  assert.equal(pinnedOptions.headers.host, 'example.test');

  let redirectCalls = 0;
  const redirectFetch = async () => {
    redirectCalls += 1;
    return new Response(null, { status: 302, headers: { location: 'https://internal.test/secret' } });
  };
  const redirectResolver = async (hostname) => hostname === 'internal.test' ? ['169.254.169.254'] : ['93.184.216.34'];
  await assert.rejects(() => security.fetchRemoteMedia('https://example.test/start', {
    resolver: redirectResolver,
    fetchImpl: redirectFetch
  }), /blocked/i);
  assert.equal(redirectCalls, 1, 'redirect destination must be rejected before second request');

  const mismatchFetch = async () => new Response(png, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  await assert.rejects(() => security.fetchRemoteMedia('https://example.test/mismatch', {
    resolver: publicResolver,
    fetchImpl: mismatchFetch
  }), /MIME mismatch/i);  const created = integration.createIntegrationApiKey('CI agent', ['content:draft:write', 'content:read']);
  assert.match(created.token, /^pk_[A-Za-z0-9_-]{40,}$/);
  assert.equal(created.key.prefix, created.token.slice(0, 12));
  const storedKey = db.prepare('SELECT key_hash,scopes_json FROM integration_api_keys WHERE id=?').get(created.key.id);
  assert.notEqual(storedKey.key_hash, created.token);
  assert.equal(JSON.stringify(storedKey).includes(created.token), false);
  assert.equal(integration.authenticateIntegrationApiKey(created.token, 'content:read').id, created.key.id);
  assert.throws(() => integration.authenticateIntegrationApiKey(created.token, 'media:write'), /lacks scope/i);

  integration.resetIntegrationRateLimitsForTests();
  assert.equal(integration.consumeIntegrationRateLimit(created.key.id, 2, 1000, 100).allowed, true);
  assert.equal(integration.consumeIntegrationRateLimit(created.key.id, 2, 1000, 101).allowed, true);
  const limited = integration.consumeIntegrationRateLimit(created.key.id, 2, 1000, 102);
  assert.equal(limited.allowed, false);
  assert.ok(limited.retryAfterMs > 0);

  const rotated = integration.rotateIntegrationApiKey(created.key.id);
  assert.notEqual(rotated.token, created.token);
  assert.equal(rotated.key.rotatedFromId, created.key.id);
  assert.throws(() => integration.authenticateIntegrationApiKey(created.token), /revoked/i);
  assert.equal(integration.authenticateIntegrationApiKey(rotated.token).id, rotated.key.id);
  integration.revokeIntegrationApiKey(rotated.key.id);
  assert.throws(() => integration.authenticateIntegrationApiKey(rotated.token), /revoked/i);  const connectorSecret = 'connector-super-secret-token';
  assert.throws(() => integration.createIngestionConnector({
    type: 'google_drive', name: 'Bad config', config: { refreshToken: 'must-not-be-here' }, credentials: {}
  }), /secret-like field/i);
  const connector = integration.createIngestionConnector({
    type: 'google_drive',
    name: 'CI Drive',
    config: { folderId: 'folder-1' },
    credentials: { refreshToken: connectorSecret }
  });
  const connectorRow = db.prepare('SELECT config_json,credentials_encrypted FROM ingestion_connectors WHERE id=?').get(connector.id);
  assert.equal(connectorRow.config_json.includes(connectorSecret), false);
  assert.equal(connectorRow.credentials_encrypted.includes(connectorSecret), false);
  assert.deepEqual(integration.readIngestionConnectorCredentials(connector.id), { refreshToken: connectorSecret });
  integration.updateIngestionConnectorCredentials(connector.id, { refreshToken: 'rotated-secret' });
  assert.deepEqual(integration.readIngestionConnectorCredentials(connector.id), { refreshToken: 'rotated-secret' });
  const eventBlob = JSON.stringify(db.prepare('SELECT message,data_json FROM publication_events').all());
  assert.equal(eventBlob.includes(connectorSecret), false);
  assert.equal(eventBlob.includes(created.token), false);

  security.assertSafeRichTextAst({
    type: 'doc',
    content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Safe text', marks: [{ type: 'bold' }] },
      { type: 'link', attrs: { href: 'https://example.com' }, content: [{ type: 'text', text: 'link' }] }
    ] }]
  });
  expectThrow(() => security.assertSafeRichTextAst({ type: 'html', text: '<script>alert(1)</script>' }), /forbidden/i);
  expectThrow(() => security.assertSafeRichTextAst({ type: 'link', attrs: { href: 'javascript:alert(1)' } }), /protocol/i);
  expectThrow(() => security.assertSafeRichTextAst({ type: 'paragraph', onClick: 'evil' }), /property/i);
  expectThrow(() => security.assertSafeRichTextAst({ type: 'text', text: 'x', marks: [{ type: 'bold', onClick: 'evil' }] }), /forbidden properties/i);
  expectThrow(() => security.assertSafeRichTextAst({ type: 'text', text: 'x', content: [] }), /cannot contain child/i);  assert.equal(security.spreadsheetSafeText('=2+2'), "'=2+2");
  assert.equal(security.spreadsheetSafeText('  @SUM(A1:A2)'), "'  @SUM(A1:A2)");
  assert.equal(security.spreadsheetSafeText('ordinary text'), 'ordinary text');
  const { createContentPlanXlsx, parseContentPlanFile, serializeContentPlanCsv } = await import('../dist/content-plan.js');
  const guardedWorkbook = await createContentPlanXlsx([{
    project: 'main', title: '=2+2', body: '@payload', schedule_mode: 'MANUAL', scheduled_at: '',
    targets: '[]', platform_overrides: '[]', media_references: '[]'
  }]);
  const guardedParsed = await parseContentPlanFile('guarded.xlsx', guardedWorkbook);
  assert.equal(guardedParsed.rows[0].cells.title, "'=2+2");
  assert.equal(guardedParsed.rows[0].cells.body, "'@payload");
  const guardedCsv = serializeContentPlanCsv([{ project: 'main', title: '=2+2', body: '@payload', schedule_mode: 'MANUAL', scheduled_at: '', targets: '[]', platform_overrides: '[]', media_references: '[]' }]);
  assert.match(guardedCsv, /'=2\+2/);
  assert.match(guardedCsv, /'@payload/);

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'M0-004',
    schemaVersion: 6,
    archiveSafety: true,
    ssrfAndRedirectSafety: true,
    dnsDestinationPinned: true,
    mimeSniffing: true,
    apiKeyHashScopesRevokeRotateRateLimit: true,
    connectorSecretsEncrypted: true,
    connectorConfigSecretFree: true,
    richTextAllowlist: true,
    spreadsheetInjectionGuard: true
  }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
