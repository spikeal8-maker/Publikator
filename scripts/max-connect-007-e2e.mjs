import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-max-connect-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: dataDir, ADMIN_PASSWORD: 'max-connect-fixture-password',
  APP_MASTER_KEY: 'max-connect-fixture-master-key-over-32-characters',
  PUBLIC_BASE_URL: 'http://127.0.0.1:18214'
});
const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();
const originalFetch = globalThis.fetch;
const secret = 'FAKE-MAX-CONNECT-007-SECRET';
let mode = 'denied';
let writes = 0;
const routes = [];
app.addHook('onRequest', async (request) => { routes.push(request.method + ' ' + request.url); });
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'platform-api2.max.ru');
  if (url.pathname === '/me') return Response.json({ user_id: 42, username: 'fixture_max_bot' });
  if (url.pathname === '/chats/-12345/members/me') {
    if (mode === 'denied') return Response.json({ message: 'forbidden token=' + secret }, { status: 403 });
    return Response.json({ user_id: 42, is_admin: true, permissions: ['write'] });
  }
  writes++;
  throw new Error('Unexpected external request');
};
let browser;
try {
  await app.listen({ host: '127.0.0.1', port: 18214 });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:18214/socials');
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('.operator-add-platform[data-platform="max"]').click();
  let form = page.locator('#operator-social-form');
  assert.equal(await form.locator('#operator-test-connect').isVisible(), false);
  await form.locator('[name="name"]').fill('MAX denied fixture');
  await form.locator('[name="accessToken"]').fill(secret);
  await form.locator('[name="chatId"]').fill('-12345');
  assert.equal(await form.locator('#operator-save-connect').textContent(), 'Сохранить и проверить');
  assert.equal(await form.locator('#operator-save-connect').isEnabled(), true);
  await form.locator('#operator-save-connect').click();
  const denied = page.locator('.operator-connection[data-platform="max"]').filter({ hasText: 'MAX denied fixture' });
  await denied.waitFor();
  assert.match(await denied.innerText(), /действителен/);
  assert.match(await denied.innerText(), /пока недоступна/);
  assert.match(await denied.innerText(), /Нет доступа к выбранному чату/);
  let account = db.prepare("SELECT * FROM social_accounts WHERE platform='max'").get();
  assert.equal(account.enabled, 0);
  assert.equal(account.credentials_encrypted.includes(secret), false);
  assert.equal((await denied.innerText()).includes(secret), false);
  assert.equal(routes.includes('POST /api/accounts/test'), false, 'save must not depend on unsaved legacy pre-test');
  assert.equal(routes.filter((route) => route === 'POST /api/accounts/save-and-check').length, 1);
  await page.reload();
  const persisted = page.locator('.operator-connection[data-platform="max"]').filter({ hasText: 'MAX denied fixture' });
  await persisted.waitFor();
  assert.match(await persisted.innerText(), /Нет доступа к выбранному чату/);
  await persisted.locator('.operator-test-account').click();
  await page.waitForFunction(() => document.querySelector('.operator-account-result')?.textContent.includes('Ключ сохранён'));
  assert.ok(routes.some((route) => route === 'POST /api/accounts/' + account.id + '/recheck'));
  assert.equal(db.prepare("SELECT count(*) AS n FROM social_accounts").get().n, 1, 'recheck must not create duplicate accounts');
  mode = 'ready';
  await page.locator('.operator-add-platform[data-platform="max"]').click();
  form = page.locator('#operator-social-form');
  await form.locator('[name="name"]').fill('MAX ready fixture');
  await form.locator('[name="accessToken"]').fill(secret);
  await form.locator('[name="chatId"]').fill('-12345');
  await form.locator('#operator-save-connect').click();
  const ready = page.locator('.operator-connection[data-platform="max"]').filter({ hasText: 'MAX ready fixture' });
  await ready.waitFor();
  assert.match(await ready.innerText(), /Публикация доступна/);
  assert.match(await ready.innerText(), /Фото: доступно/);
  account = db.prepare("SELECT * FROM social_accounts WHERE name='MAX ready fixture'").get();
  assert.equal(account.enabled, 1);
  assert.equal(writes, 0, 'connection checks must never publish/upload');
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log(JSON.stringify({ checkpoint: 'MAX-CONNECT-007', ok: true, encryptedPersistFirst: true,
    validTokenDeniedChat: true, persistedDiagnostic: true, savedSecretRecheck: true, readyActivation: true, publicWrites: writes }));
} finally {
  await browser?.close();
  globalThis.fetch = originalFetch;
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
