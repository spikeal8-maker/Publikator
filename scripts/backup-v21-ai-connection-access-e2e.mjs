import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-ai-connection-access-'));
Object.assign(process.env, {
  DATA_DIR: directory, NODE_ENV: 'test', PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
  APP_MASTER_KEY: 'ai-connection-access-fixture-secret-at-least-32-characters',
});
delete process.env.ADMIN_PASSWORD;
const { db, migrate } = await import('../dist/db.js');
const { createAdminSetupGrant, createOrRecoverAdmin } = await import('../dist/admin-auth.js');
const { saveAiConnection, updateAiConnectionAccess } = await import('../dist/owner-ai-providers.js');

function makeConnection() {
  const password = 'ai-settings-fixture-owner-password';
  createOrRecoverAdmin('INITIAL', createAdminSetupGrant('INITIAL'), 'owner', password, password);
  return saveAiConnection('owner', { provider:'ollama', name:'Fixture', model:'fixture', baseUrl:'http://127.0.0.1:11434', apiKey:'fixture-provider-key' });
}

const { config } = await import('../dist/config.js');
const { createBackupBundle, resolveBackupBundle, stageRestoreBundle } = await import('../dist/backups.js');
const { applyPendingRestore } = await import('../dist/restore-bootstrap.js');
let restored;
try {
  migrate();
  const connection = makeConnection();
  const readOnly=updateAiConnectionAccess('owner', connection.id, {accessMode:'READ_ONLY',expectedRevision:1});
  const before=db.prepare('SELECT * FROM owner_ai_connections WHERE id=?').get(connection.id);
  const backup=await createBackupBundle('ai-connection-access');
  updateAiConnectionAccess('owner', connection.id, {accessMode:'OWNER_TOOLS', confirmElevation:true,expectedRevision:readOnly.revision});
  await stageRestoreBundle(resolveBackupBundle(backup.name));
  db.close();
  assert.equal((await applyPendingRestore()).applied,true);
  restored=new Database(config.dbPath,{fileMustExist:true});
  assert.deepEqual(restored.prepare('SELECT * FROM owner_ai_connections WHERE id=?').get(connection.id),before);
  assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');
  console.log('Canonical backup restores server-enforced model access and its revision PASS');
} finally {
  restored?.close();
  if(db.open)db.close();
  await fs.rm(directory,{recursive:true,force:true,maxRetries:5});
}
