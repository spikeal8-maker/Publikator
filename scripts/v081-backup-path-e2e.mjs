import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-v081-backup-'));
process.env.DATA_DIR = dataDir;

const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');

migrate();
const app = await buildApp();
await app.ready();

try {
  const password = process.env.ADMIN_PASSWORD;
  assert.ok(password);

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers['set-cookie'];
  assert.equal(typeof setCookie, 'string');
  const cookie = setCookie.split(';')[0];

  for (const method of ['GET', 'POST']) {
    const legacy = await app.inject({ method, url: '/api/backups', headers: { cookie } });
    assert.equal(legacy.statusCode, 410, legacy.body);
    assert.match(legacy.json().error, /backup-bundles/);
  }

  const initial = await app.inject({ method: 'GET', url: '/api/backup-bundles', headers: { cookie } });
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), []);

  const created = await app.inject({
    method: 'POST',
    url: '/api/backup-bundles',
    headers: { cookie },
    payload: { label: 'single-path-ci' }
  });
  assert.equal(created.statusCode, 201, created.body);
  const bundle = created.json();
  assert.match(bundle.name, /^publikator-.*-single-path-ci\.tgz$/);
  assert.ok(bundle.sizeBytes > 0);

  const listed = await app.inject({ method: 'GET', url: '/api/backup-bundles', headers: { cookie } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().length, 1);
  assert.equal(listed.json()[0].name, bundle.name);

  const legacyFiles = (await fs.readdir(path.join(dataDir, 'backups'))).filter((name) => name.endsWith('.sqlite'));
  assert.deepEqual(legacyFiles, []);

  console.log(JSON.stringify({ ok: true, canonicalBundle: bundle.name }, null, 2));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
