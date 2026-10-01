import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-key-02-browser-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'key-02-browser-password';
process.env.APP_MASTER_KEY = 'key-02-browser-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:18092';

const { db, migrate } = await import('../dist/db.js');
const { decryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();
await app.listen({ host: '127.0.0.1', port: 18092 });

const base = 'http://127.0.0.1:18092';
const partialCheck = {
  ok: true,
  platform: 'vk',
  identity: 'Сообщество · Public Community',
  destination: 'https://vk.com/club67890',
  details: {
    apiVersion: '5.199',
    keyValidity: 'CONFIRMED',
    authKind: 'USER',
    permissions: [],
    permissionsSource: 'NOT_CONFIRMED_FOR_USER_KEY',
    authenticatedUserId: '12345',
    authenticatedUserName: 'User Fixture',
    destinationKind: 'COMMUNITY',
    destinationStatus: 'CONFIRMED',
    destinationId: '67890',
    destinationName: 'Public Community',
    destinationScreenName: 'club67890',
    destinationOwnershipConfirmed: false,
    wallPhotoReady: false,
    wallUploadReady: false,
    wallPostNotExecuted: true,
    publishReady: false,
    methods: [
      { method: 'users.get', state: 'CONFIRMED', reason: 'VK вернул владельца пользовательского ключа.' },
      { method: 'groups.getById', state: 'CONFIRMED', reason: 'Публичные данные группы прочитаны; владение не доказано.' },
      { method: 'photos.getWallUploadServer', state: 'DENIED', reason: 'VK отказал этому методу.' },
      { method: 'wall.post', state: 'NOT_CHECKED', reason: 'Проверка ничего не публикует.' },
      { method: 'photos.getUploadServer / photos.save', state: 'NOT_IMPLEMENTED', reason: 'Альбомный путь пока не реализован.' },
      { method: 'stories.getPhotoUploadServer / stories.save', state: 'NOT_IMPLEMENTED', reason: 'Stories не реализованы в KEY-02.' }
    ]
  }
};

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const pageErrors = [];
  const inspectBodies = [];
  const testBodies = [];
  const savedRetestBodies = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));

  await page.route('**/api/vk/token/inspect', async (route) => {
    const body = route.request().postDataJSON();
    inspectBodies.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        valid: true,
        authKind: 'USER',
        identity: 'User Fixture',
        userId: '12345',
        userScreenName: 'id12345',
        methods: [{ method: 'users.get', state: 'CONFIRMED', reason: 'VK вернул владельца.' }]
      })
    });
  });

  await page.route('**/api/accounts/test', async (route) => {
    const body = route.request().postDataJSON();
    testBodies.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(partialCheck)
    });
  });

  await page.route(/\/api\/accounts\/[^/]+\/test$/, async (route) => {
    savedRetestBodies.push(route.request().postData());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...partialCheck,
        details: {
          ...partialCheck.details,
          credentialOnly: true,
          verificationStatus: 'PENDING'
        }
      })
    });
  });

  await page.goto(`${base}/socials`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login').waitFor({ state: 'visible' });
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Соцсети');

  await page.locator('.operator-platform-card[data-platform="vk"] .operator-add-platform').click();
  const form = page.locator('#operator-social-form');
  await form.waitFor({ state: 'visible' });
  await form.locator('input[name="name"]').fill('KEY-02 Partial');
  await form.locator('input[name="destinationKind"][value="COMMUNITY"]').check();
  await form.locator('input[name="groupId"]').fill('67890');
  await form.locator('input[name="accessToken"]').fill('browser-partial-secret');

  await form.locator('#operator-test-connect').click();
  const card = form.locator('#operator-connect-result');
  await card.getByText(/Действительность ключа подтверждена/).waitFor();
  const cardText = await card.textContent();
  assert.match(cardText, /User Fixture/);
  assert.match(cardText, /Public Community/);
  assert.match(cardText, /photos\.getWallUploadServer/);
  assert.match(cardText, /Метод отказал/);
  assert.match(cardText, /photos\.getUploadServer \/ photos\.save/);
  assert.match(cardText, /Не реализовано в Publikator/);
  assert.match(cardText, /Чтение данных группы не доказывает владение/);
  assert.match(cardText, /Публикация не включается/);
  assert.equal(await form.locator('#operator-save-connect').textContent(), 'Сохранить ключ VK');
  assert.equal(await form.locator('#operator-save-connect').isEnabled(), true);
  assert.equal(inspectBodies.length, 1);
  assert.equal(testBodies.length, 1);

  await form.locator('#operator-save-connect').click();
  await page.getByText('KEY-02 Partial', { exact: true }).waitFor();

  const row = db.prepare("SELECT * FROM social_accounts WHERE name='KEY-02 Partial'").get();
  assert.ok(row);
  assert.equal(row.enabled, 0);
  assert.equal(row.credentials_encrypted.includes('browser-partial-secret'), false);
  const stored = decryptJson(row.credentials_encrypted);
  assert.equal(stored.authKind, 'PENDING');
  assert.equal(stored.destinationKind, 'COMMUNITY');
  assert.equal(stored.groupId, '67890');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_default_targets WHERE account_id=?').get(row.id).n, 0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Соцсети');
  const savedRow = page.locator(`.operator-connection[data-account-id="${row.id}"]`);
  await savedRow.waitFor({ state: 'visible' });
  assert.match(await savedRow.textContent(), /Ключ сохранён · проверка не завершена · публикация выключена/);
  assert.equal((await page.content()).includes('browser-partial-secret'), false);

  await savedRow.locator('.operator-test-account').click();
  await savedRow.getByText(/Действительность ключа подтверждена/).waitFor();
  const retestText = await savedRow.locator('.operator-account-result').textContent();
  assert.match(retestText, /User Fixture/);
  assert.match(retestText, /photos\.getWallUploadServer/);
  assert.match(retestText, /Метод отказал/);
  assert.equal(savedRetestBodies.length, 1);
  assert.equal(savedRetestBodies[0], null, 'saved-account retest must not resend a secret from the browser');
  assert.equal((await page.content()).includes('browser-partial-secret'), false);
  assert.equal(await savedRow.locator('.operator-toggle-account').count(), 0, 'PENDING account must not expose enable bypass');
  assert.deepEqual(pageErrors, []);

  await context.close();
  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'KEY-02-BROWSER',
    capabilityCard: true,
    pendingSave: true,
    reloadVisible: true,
    retestWithoutBrowserSecret: true,
    noEnableBypass: true
  }));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
