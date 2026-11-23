import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-ai-connection-access-'));
Object.assign(process.env, {
  DATA_DIR: directory, NODE_ENV: 'test', PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
  APP_MASTER_KEY: 'ai-connection-access-fixture-secret-at-least-32-characters',
});
delete process.env.ADMIN_PASSWORD;
const { db, migrate, DATABASE_SCHEMA_VERSION } = await import('../dist/db.js');
const { createAdminSetupGrant, createOrRecoverAdmin } = await import('../dist/admin-auth.js');
const { saveAiConnection, updateAiConnectionAccess } = await import('../dist/owner-ai-providers.js');

function makeConnection() {
  const password = 'ai-settings-fixture-owner-password';
  createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'), 'owner', password, password);
  return saveAiConnection('owner', { provider:'ollama', name:'Fixture', model:'fixture', baseUrl:'http://127.0.0.1:11434', apiKey:'fixture-provider-key' });
}

try {
  migrate();
  const connection = makeConnection();
  const prior = db.prepare('SELECT credentials_encrypted FROM owner_ai_connections WHERE id=?').get(connection.id);
  db.exec('ALTER TABLE owner_ai_connections DROP COLUMN access_mode');
  db.pragma('user_version = 20');
  migrate();
  assert.equal(db.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT access_mode FROM owner_ai_connections WHERE id=?').get(connection.id).access_mode, 'OWNER_TOOLS');
  const readOnly = updateAiConnectionAccess('owner', connection.id, { accessMode:'READ_ONLY',expectedRevision:1 });
  assert.equal(readOnly.accessMode,'READ_ONLY');
  assert.equal(readOnly.revision,2);
  assert.throws(() => updateAiConnectionAccess('another-owner',connection.id,{accessMode:'OWNER_TOOLS', expectedRevision:2}),
    {code:'CONNECTION_NOT_FOUND'});
  assert.throws(() => updateAiConnectionAccess('owner',connection.id,{accessMode:'OWNER_TOOLS', expectedRevision:1}),
    {code:'VERSION_CONFLICT'});
  assert.throws(() => updateAiConnectionAccess('owner',connection.id,{accessMode:'OWNER_TOOLS', expectedRevision:2}),
    {code:'CONFIRM_MODEL_ACCESS'});
  migrate();
  assert.deepEqual(db.prepare('SELECT credentials_encrypted FROM owner_ai_connections WHERE id=?').get(connection.id),prior);
  assert.equal(db.prepare('SELECT access_mode FROM owner_ai_connections WHERE id=?').get(connection.id).access_mode,'READ_ONLY');
  console.log('Schema 21 access migration preserves credentials and restrictive model policy PASS');
} finally {
  db.close();
  await fs.rm(directory,{recursive:true,force:true,maxRetries:5});
}
