import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-max-destination-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: dataDir, ADMIN_PASSWORD: 'max-destination-fixture-password',
  APP_MASTER_KEY: 'max-destination-fixture-master-key-over-32-characters',
  PUBLIC_BASE_URL: 'http://127.0.0.1:18215'
});
const { db, migrate } = await import('../dist/db.js');
const { decryptJson, encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();
const originalFetch = globalThis.fetch;
const secret = 'FAKE-MAX-DESTINATION-008-SECRET';
let writes = 0;
app.addHook('onRequest', async (request) => {});
app.addHook('preHandler', async (request) => {
  if (request.url.endsWith('/max-destination')) {
    assert.equal(JSON.stringify(request.body).includes(secret), false);
    assert.equal(Object.hasOwn(request.body || {}, 'credentials'), false);
  }
});
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'platform-api2.max.ru');
  assert.equal(init.headers.Authorization, secret);
  if (url.pathname === '/me') return Response.json({ user_id: 42, username: 'fixture_max_bot' });
  if (/^\/chats\/-\d+\/members\/me$/.test(url.pathname)) {
    if (url.pathname.includes('-444')) return Response.json({ message: 'Bot is not a chat member token=' + secret }, { status: 403 });
    return Response.json({ user_id: 42, is_admin: true, permissions: ['write'] });
  }
  writes++;
  throw new Error('Unexpected external write');
};
let browser;
try {
  await app.listen({ host: '127.0.0.1', port: 18215 });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const headers = { cookie };
  const saved = await app.inject({ method: 'POST', url: '/api/accounts/save-and-check', headers,
    payload: { platform: 'max', name: 'Original chat', credentials: { accessToken: secret, chatId: '-111' } } });
  assert.equal(saved.statusCode, 201, saved.body);
  const originalId = saved.json().account.id;
  const originalVersion = saved.json().capabilityProfile.credentialVersion;
  const originalFingerprint = saved.json().capabilityProfile.profileFingerprint;
  const payload = { name: 'New chat', chatId: '-222', mode: 'replace', expectedCredentialVersion: originalVersion };
  const unauthenticated = await app.inject({ method: 'POST', url: '/api/accounts/' + originalId + '/max-destination', payload });
  assert.equal(unauthenticated.statusCode, 401);
  for (const chatId of ['0', 'hello', 'https://max.ru/join/fixture', '9223372036854775808']) {
    const response = await app.inject({ method: 'POST', url: '/api/accounts/' + originalId + '/max-destination', headers, payload: { ...payload, chatId } });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(db.prepare('SELECT credential_version FROM social_accounts WHERE id=?').get(originalId).credential_version, originalVersion);
  const mismatch = await app.inject({ method: 'POST', url: '/api/accounts/' + originalId + '/max-destination', headers,
    payload: { ...payload, expectedCredentialVersion: originalVersion + 1 } });
  assert.equal(mismatch.statusCode, 409);
  const when = new Date().toISOString();
  db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES ('not-max','telegram','Telegram fixture',?,0,?,?)")
    .run(encryptJson({ botToken: 'fixture', chatId: '@fixture' }), when, when);
  const notMax = await app.inject({ method: 'POST', url: '/api/accounts/not-max/max-destination', headers, payload: { ...payload, expectedCredentialVersion: 1 } });
  assert.equal(notMax.statusCode, 400);
  await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Destination safety fixture' } });
  const project = db.prepare('SELECT id FROM projects LIMIT 1').get();
  const created = await app.inject({ method: 'POST', url: '/api/posts', headers,
    payload: { projectId: project.id, title: 'Approved original destination', body: 'Neutral fixture', contentFormat: 'TEXT_ONLY' } });
  assert.equal(created.statusCode, 201, created.body);
  const postId = created.json().id;
  let version = db.prepare('SELECT content_version FROM posts WHERE id=?').get(postId).content_version;
  const targets = await app.inject({ method: 'PUT', url: '/api/posts/' + postId + '/targets', headers,
    payload: { accountIds: [originalId], expectedContentVersion: version } });
  assert.equal(targets.statusCode, 200, targets.body);
  version = targets.json().contentVersion;
  const ready = await app.inject({ method: 'POST', url: '/api/posts/' + postId + '/ready', headers,
    payload: { expectedContentVersion: version } });
  assert.equal(ready.statusCode, 200, ready.body);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:18215/socials');
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  let row = page.locator('.operator-connection[data-account-id="' + originalId + '"]');
  await row.getByRole('button', { name: 'Изменить чат', exact: true }).click();
  let form = row.locator('.operator-max-destination-form');
  assert.equal(await form.locator('input[type="password"]').count(), 0);
  await form.locator('[name="name"]').fill('Changed chat');
  await form.locator('[name="chatId"]').fill('-222');
  await form.getByRole('button', { name: 'Сохранить и проверить', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  row = page.locator('.operator-connection[data-account-id="' + originalId + '"]');
  assert.match(await row.innerText(), /Changed chat/);
  assert.match(await row.innerText(), /Публикация доступна/);
  let account = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(originalId);
  assert.equal(decryptJson(account.credentials_encrypted).chatId, '-222');
  assert.equal(decryptJson(account.credentials_encrypted).accessToken, secret);
  assert.ok(account.credential_version > originalVersion);
  assert.equal(account.enabled, 1);
  const listed = await app.inject({ method: 'GET', url: '/api/accounts', headers });
  assert.equal(listed.body.includes(secret), false);
  assert.notEqual(listed.json().find((item) => item.id === originalId).capabilityProfile.profileFingerprint, originalFingerprint);
  await app.inject({ method: 'POST', url: '/api/posts/' + postId + '/publish-now', headers });
  assert.notEqual(db.prepare('SELECT status FROM posts WHERE id=?').get(postId).status, 'PUBLISHED');
  assert.equal(writes, 0, 'READY approved for the old destination must never redirect to the new chat');
  await row.getByRole('button', { name: 'Добавить чат', exact: true }).click();
  form = row.locator('.operator-max-destination-form');
  await form.locator('[name="name"]').fill('Second chat');
  await form.locator('[name="chatId"]').fill('-333');
  await form.getByRole('button', { name: 'Сохранить и проверить', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  const second = db.prepare("SELECT * FROM social_accounts WHERE name='Second chat'").get();
  assert.notEqual(second.id, originalId);
  assert.equal(decryptJson(second.credentials_encrypted).accessToken, secret);
  assert.equal(decryptJson(second.credentials_encrypted).chatId, '-333');
  assert.equal(decryptJson(db.prepare('SELECT credentials_encrypted FROM social_accounts WHERE id=?').get(originalId).credentials_encrypted).chatId, '-222');
  account = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(originalId);
  const denied = await app.inject({ method: 'POST', url: '/api/accounts/' + originalId + '/max-destination', headers,
    payload: { name: 'Denied chat', chatId: '-444', mode: 'replace', expectedCredentialVersion: account.credential_version } });
  assert.equal(denied.statusCode, 200, denied.body);
  assert.equal(denied.json().account.enabled, false);
  assert.equal(denied.json().capabilityProfile.semantic.credential.validity, 'CONFIRMED');
  assert.equal(denied.json().capabilityProfile.semantic.destination.resolutionState, 'DENIED');
  assert.equal(denied.body.includes(secret), false);
  assert.equal(writes, 0);
  console.log(JSON.stringify({ checkpoint: 'MAX-DEST-008', ok: true, editChat: true, addSameBotChat: true,
    versionConflict: true, noSecretResubmission: true, priorReadyNotRedirected: true, deniedChatDisabled: true, publicWrites: writes }));
} finally {
  await browser?.close();
  globalThis.fetch = originalFetch;
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
