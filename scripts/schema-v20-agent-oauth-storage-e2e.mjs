import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-oauth-storage-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.APP_MASTER_KEY = 'oauth-storage-migration-fixture-key-long-enough';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8080';
delete process.env.ADMIN_PASSWORD;

const { db, migrate } = await import('../dist/db.js');
const { DATABASE_SCHEMA_VERSION } = await import('../dist/schema.js');
const { createSQLiteOAuthAdapter } = await import('../dist/agent-oauth-adapter.js');

try {
  migrate();
  const existing = db.prepare('SELECT * FROM projects ORDER BY id').all();
  db.exec('DROP TABLE agent_oauth_artifacts');
  db.pragma('user_version = 19');
  migrate();
  assert.equal(db.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION);
  assert.deepEqual(db.prepare('SELECT * FROM projects ORDER BY id').all(), existing);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_oauth_artifacts').get().count, 0);

  const adapter = createSQLiteOAuthAdapter(db);
  const codes = adapter('AuthorizationCode');
  const refreshTokens = adapter('RefreshToken');
  const session = adapter('Session');
  const devices = adapter('DeviceCode');
  const grant = 'test-grant-not-stored-in-plaintext';
  const code = 'test-code-not-stored-in-plaintext';
  const payload = { grantId: grant, data: 'confidential-fixture-canary' };
  await codes.upsert(code, payload, 60);
  await refreshTokens.upsert('refresh-1', { grantId: grant }, 60);
  await refreshTokens.upsert('refresh-2', { grantId: 'separate-grant' }, 60);
  await session.upsert('s1', { uid: 'stable-session-uid' }, 60);
  await devices.upsert('d1', { userCode: 'test-user-code' }, 60);
  assert.deepEqual(await session.findByUid('stable-session-uid'), { uid: 'stable-session-uid' });
  assert.deepEqual(await devices.findByUserCode('test-user-code'), { userCode: 'test-user-code' });
  assert.deepEqual(await codes.find(code), payload);
  assert.equal(await refreshTokens.find(code), undefined);
  const raw = JSON.stringify(db.prepare('SELECT * FROM agent_oauth_artifacts').all());
  for (const value of [grant, code, payload.data, 'stable-session-uid', 'test-user-code', 'refresh-1']) {
    assert.equal(raw.includes(value), false);
  }

  const attempts = await Promise.allSettled([codes.consume(code), codes.consume(code)]);
  assert.deepEqual(attempts.map((attempt) => attempt.status), ['fulfilled', 'rejected']);
  const consumed = await codes.find(code);
  assert.equal(typeof consumed?.consumed, 'number');
  await codes.upsert(code, { ...payload, data: 'updated' }, 60);
  assert.equal((await codes.find(code))?.consumed, consumed?.consumed);
  await assert.rejects(codes.consume(code), /no longer available/);

  await session.upsert('s1', { uid: 'new-session-uid' }, 60);
  assert.equal(await session.findByUid('stable-session-uid'), undefined);
  await codes.upsert('already-expired', {}, 0);
  assert.equal(await codes.find('already-expired'), undefined);
  await assert.rejects(codes.consume('already-expired'), /no longer available/);

  migrate();
  assert.equal((await createSQLiteOAuthAdapter(db)('AuthorizationCode').find(code))?.consumed, consumed?.consumed);
  await codes.revokeByGrantId(grant);
  assert.equal(await codes.find(code), undefined);
  assert.equal(await refreshTokens.find('refresh-1'), undefined);
  assert.deepEqual(await refreshTokens.find('refresh-2'), { grantId: 'separate-grant' });
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  console.log('OAuth storage migration, encryption, single consumption and grant revocation PASS');
} finally {
  db.close();
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
