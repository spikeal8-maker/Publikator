import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-google-setup-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'google-setup-fixture-password';
process.env.APP_MASTER_KEY = 'google-setup-fixture-master-key-longer-than-thirty-two';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:18893';
const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();
const pem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const credentials = { type: 'service_account', client_email: 'setup@test.iam.gserviceaccount.com', private_key: pem };
const originalFetch = globalThis.fetch;
let denyDrive = false, denySheet = false, disableOnDrive = '', networkCalls = 0;
globalThis.fetch = async input => {
  networkCalls++;
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-token' });
  if (url.startsWith('https://sheets.googleapis.com/')) return denySheet
    ? Response.json({ error: { message: pem } }, { status: 403 })
    : Response.json({ properties: { title: 'Fixture' }, sheets: [{ properties: { title: 'Публикации' } }] });
  if (url.startsWith('https://www.googleapis.com/drive/v3/files/')) {
    if (disableOnDrive) { db.prepare('UPDATE ingestion_connectors SET enabled=0 WHERE id=?').run(disableOnDrive); disableOnDrive = ''; }
    return denyDrive ? Response.json({ error: { message: pem } }, { status: 403 })
      : Response.json({ id: 'folder_fixture_123', name: 'Фото', mimeType: 'application/vnd.google-apps.folder' });
  }
  throw new Error('Unexpected provider request');
};
try {
  const auth = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(auth.statusCode, 200);
  const cookie = String(auth.headers['set-cookie']).split(';')[0];
  const request = (op, payload, authorized = true) => app.inject({ method: 'POST', url: '/api/google-sheets/setup/' + op, headers: authorized ? { cookie } : {}, payload });
  const count = () => db.prepare('SELECT count(*) AS n FROM ingestion_connectors').get().n;
  const input = { name: 'План', spreadsheetId: 'sheet_fixture_123', sheetName: 'Публикации', writeBack: true, rootFolder: 'folder_fixture_123', mediaName: 'Фото проекта', credentials };
  assert.equal((await request('inspect', input, false)).statusCode, 401);
  assert.equal(networkCalls, 0);
  denySheet = true; denyDrive = true;
  let response = await request('inspect', input);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().sheet.ok, false);
  assert.equal(response.json().folder.ok, false);
  assert.equal(response.json().canSave, false);
  assert.ok(!response.body.includes('PRIVATE KEY'));
  denySheet = false;
  response = await request('inspect', input);
  assert.equal(response.json().sheet.ok, true);
  assert.equal(response.json().folder.ok, false);
  assert.equal(response.json().canSave, false);
  assert.equal(count(), 0);
  response = await request('save', input);
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /папке/);
  assert.ok(!response.body.includes('PRIVATE KEY'));
  assert.equal(count(), 0, 'failed Drive validation leaves no Sheet source');
  denyDrive = false;
  assert.equal((await request('save', { ...input, mediaName: '' })).statusCode, 400);
  assert.equal(count(), 0, 'late name validation rolls back both connectors and events');
  assert.equal(db.prepare("SELECT count(*) AS n FROM publication_events WHERE event_type='connector.created'").get().n, 0);
  response = await request('save', input);
  assert.equal(response.statusCode, 200, response.body);
  const first = response.json();
  assert.equal(count(), 2);
  assert.ok(!response.body.includes('private_key'));
  assert.ok(!response.body.includes(pem));
  const sheetId = first.sheetConnector.id;
  const driveId = first.mediaConnector.id;
  assert.ok(!db.prepare('SELECT credentials_encrypted FROM ingestion_connectors WHERE id=?').get(sheetId).credentials_encrypted.includes(pem));
  response = await request('save', input);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().sheetConnector.id, sheetId);
  assert.equal(response.json().mediaConnector.id, driveId);
  assert.equal(count(), 2, 'retry reuses exact connections');

  const replacement = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  response = await request('save', { ...input, credentials: { ...credentials, private_key: replacement } });
  assert.equal(response.statusCode, 400, 'retry with a different key must not silently reuse the older secret');
  assert.equal(count(), 2);

  const reuse = { existingConnectorId: sheetId, rootFolder: input.rootFolder, mediaName: input.mediaName };
  response = await request('inspect', reuse);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().canSave, true);
  assert.equal(response.json().serviceAccountEmail, credentials.client_email);
  assert.ok(!response.body.includes('private_key'));
  assert.equal((await request('save', reuse)).json().sheetConnector.id, sheetId);
  assert.equal(count(), 2, 'attaching existing folder preserves the original Sheet identity');
  const beforeDenied = networkCalls;
  for (const bad of [
    { existingConnectorId: driveId },
    { existingConnectorId: 'nonexistent' },
    { existingConnectorId: sheetId, credentials },
    { existingConnectorId: sheetId, spreadsheetId: 'another_sheet_123' }
  ]) {
    assert.equal((await request('inspect', bad)).statusCode, 400);
    assert.equal((await request('save', bad)).statusCode, 400);
  }
  assert.equal(networkCalls, beforeDenied, 'invalid saved references never contact Google');
  response = await request('save', { ...reuse, rootFolder: 'other_folder_12345' });
  assert.equal(response.statusCode, 400, 'same name cannot silently point to a different folder');
  assert.equal(count(), 2);
  disableOnDrive = sheetId;
  response = await request('save', { ...reuse, rootFolder: 'new_folder_12345', mediaName: 'Новая папка' });
  assert.equal(response.statusCode, 400, 'disable during network inspection blocks stale save');
  assert.equal(count(), 2);
  assert.equal((await request('inspect', reuse)).statusCode, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM posts').get().n, 0);
  assert.ok(!JSON.stringify(db.prepare('SELECT message,data_json FROM publication_events').all()).includes('PRIVATE KEY'));
  console.log('GOOGLE-SETUP-001 API: auth, one identity, independent checks, atomicity, reuse, no duplicates, stale/disabled refs and no-secret output PASS');
} finally {
  globalThis.fetch = originalFetch;
  await app.close(); db.close();
  await fs.rm(dir, { recursive: true, force: true });
}
