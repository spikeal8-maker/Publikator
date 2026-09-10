import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-v084-security-'));
process.env.DATA_DIR = dataDir;

const password = process.env.ADMIN_PASSWORD;
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
assert.ok(password);
assert.ok(publicBaseUrl);
const publicOrigin = new URL(publicBaseUrl).origin;

const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');

migrate();
const app = await buildApp();
await app.ready();

try {
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  assert.equal(health.headers['x-frame-options'], 'DENY');
  assert.equal(health.headers['referrer-policy'], 'no-referrer');
  assert.equal(health.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(health.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(health.headers['strict-transport-security'], 'max-age=31536000');
  assert.match(String(health.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.match(String(health.headers['content-security-policy']), /object-src 'none'/);

  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);

  const media404 = await app.inject({ method: 'GET', url: '/public-media/not-found.jpg' });
  assert.equal(media404.statusCode, 404);
  assert.equal(media404.headers['cross-origin-resource-policy'], 'cross-origin');

  const foreignLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'https://evil.example.test' },
    payload: { password }
  });
  assert.equal(foreignLogin.statusCode, 403);
  assert.match(foreignLogin.json().error, /Origin/);

  const malformedOrigin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'null' },
    payload: { password }
  });
  assert.equal(malformedOrigin.statusCode, 403);

  const sameOriginLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: publicOrigin },
    payload: { password }
  });
  assert.equal(sameOriginLogin.statusCode, 200, sameOriginLogin.body);
  const setCookie = sameOriginLogin.headers['set-cookie'];
  assert.equal(typeof setCookie, 'string');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Secure/i);
  const cookie = setCookie.split(';')[0];

  const siblingMutation = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { origin: 'https://sibling.example.test', cookie },
    payload: { name: 'Must not exist', slug: 'must-not-exist' }
  });
  assert.equal(siblingMutation.statusCode, 403);

  const suffixAttack = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { origin: `${publicOrigin}.attacker.test`, cookie },
    payload: { name: 'Suffix attack', slug: 'suffix-attack' }
  });
  assert.equal(suffixAttack.statusCode, 403);

  const sameOriginMutation = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { origin: publicOrigin, cookie },
    payload: { name: 'Same origin project', slug: 'same-origin-project' }
  });
  assert.equal(sameOriginMutation.statusCode, 201, sameOriginMutation.body);

  const localHostMutation = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { origin: 'http://local-admin.test:8080', host: 'local-admin.test:8080', cookie },
    payload: { name: 'Local admin project', slug: 'local-admin-project' }
  });
  assert.equal(localHostMutation.statusCode, 201, localHostMutation.body);

  const cliLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password }
  });
  assert.equal(cliLogin.statusCode, 200, cliLogin.body);

  const blockedCount = Number(db.prepare("SELECT COUNT(*) AS count FROM projects WHERE slug IN ('must-not-exist','suffix-attack')").get().count);
  assert.equal(blockedCount, 0);

  console.log(JSON.stringify({ ok: true, publicOrigin, securityHeaders: true, originGuard: true }, null, 2));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
