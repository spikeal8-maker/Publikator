import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-backup-v6-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'backup-v6-ci-password';
process.env.APP_MASTER_KEY = 'backup-v6-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate } = await import('../dist/db.js');
const { config } = await import('../dist/config.js');
const integration = await import('../dist/integration-security.js');
const { createBackupBundle, resolveBackupBundle, stageRestoreBundle } = await import('../dist/backups.js');
const { applyPendingRestore } = await import('../dist/restore-bootstrap.js');

migrate();
const api = integration.createIntegrationApiKey('Backup CI', ['content:read']);
const connectorSecret = 'backup-connector-secret';
const connector = integration.createIngestionConnector({
  type: 'google_drive', name: 'Backup Drive', config: { folderId: 'folder-x' },
  credentials: { refreshToken: connectorSecret }
});const keyBefore = db.prepare('SELECT * FROM integration_api_keys WHERE id=?').get(api.key.id);
const connectorBefore = db.prepare('SELECT * FROM ingestion_connectors WHERE id=?').get(connector.id);
assert.equal(JSON.stringify(keyBefore).includes(api.token), false);
assert.equal(JSON.stringify(connectorBefore).includes(connectorSecret), false);

const bundle = await createBackupBundle('schema6-security');
const bundlePath = resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size > 0);

integration.revokeIntegrationApiKey(api.key.id);
integration.updateIngestionConnectorCredentials(connector.id, { refreshToken: 'mutated-secret' });
assert.notDeepEqual(db.prepare('SELECT * FROM integration_api_keys WHERE id=?').get(api.key.id), keyBefore);
assert.notDeepEqual(db.prepare('SELECT * FROM ingestion_connectors WHERE id=?').get(connector.id), connectorBefore);

const staged = await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion, 6);
db.close();
const applied = await applyPendingRestore();
assert.equal(applied.applied, true);

const restored = new Database(config.dbPath, { readonly: true, fileMustExist: true });
try {
  assert.equal(Number(restored.pragma('user_version', { simple: true })), 6);
  assert.deepEqual(restored.prepare('SELECT * FROM integration_api_keys WHERE id=?').get(api.key.id), keyBefore);
  assert.deepEqual(restored.prepare('SELECT * FROM ingestion_connectors WHERE id=?').get(connector.id), connectorBefore);
  const databaseBlob = JSON.stringify(restored.prepare('SELECT * FROM integration_api_keys').all()) + JSON.stringify(restored.prepare('SELECT * FROM ingestion_connectors').all());
  assert.equal(databaseBlob.includes(api.token), false);
  assert.equal(databaseBlob.includes(connectorSecret), false);  console.log(JSON.stringify({
    ok: true,
    schemaVersion: 6,
    apiKeyHashPreserved: true,
    connectorCiphertextPreserved: true,
    plaintextSecretsAbsent: true,
    pendingRestoreApplied: true
  }, null, 2));
} finally {
  restored.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
