import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-key-03-browser-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'key-03-browser-password';
process.env.APP_MASTER_KEY = 'key-03-browser-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:18093';

const { db, migrate } = await import('../dist/db.js');
const { decryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');

migrate();
const app = await buildApp();
await app.listen({ host: '127.0.0.1', port: 18093 });

const base = 'http://127.0.0.1:18093';
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const pageErrors = [];
  const testBodies = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));

  await page.route('**/api/vk/token/inspect', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        valid: true,
        authKind: 'USER',
        identity: 'Album Owner',
        userId: '12345',
        userScreenName: 'id12345',
        methods: [{ method: 'users.get', state: 'CONFIRMED', reason: 'VK вернул владельца.' }]
      })
    });
  });

  await page.route('**/api/accounts/test', async (route) => {
    const body = route.request().postDataJSON();
    testBodies.push(body);
    assert.equal(body.platform, 'vk');
    assert.equal(body.credentials.destinationKind, 'COMMUNITY');
    assert.equal(body.credentials.groupId, '67890');
    assert.equal(body.credentials.albumId, '777');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        platform: 'vk',
        identity: 'Сообщество · Album Community',
        destination: 'https://vk.com/club67890',
        details: {
          apiVersion: '5.199',
          keyValidity: 'CONFIRMED',
          authKind: 'USER',
          permissions: [],
          permissionsSource: 'NOT_CONFIRMED_FOR_USER_KEY',
          authenticatedUserId: '12345',
          authenticatedUserName: 'Album Owner',
          destinationKind: 'COMMUNITY',
          destinationStatus: 'CONFIRMED',
          destinationId: '67890',
          destinationName: 'Album Community',
          destinationScreenName: 'club67890',
          destinationOwnershipConfirmed: false,
          wallPhotoReady: false,
          wallUploadReady: false,
          albumUploadReady: true,
          albumId: '777',
          imageUploadMode: 'ALBUM',
          wallPostNotExecuted: true,
          publishReady: true,
          methods: [
            { method: 'users.get', state: 'CONFIRMED', reason: 'VK вернул владельца.' },
            { method: 'groups.getById', state: 'CONFIRMED', reason: 'Публичные данные группы прочитаны.' },
            { method: 'photos.getWallUploadServer', state: 'DENIED', reason: 'Wall path denied.' },
            { method: 'photos.getUploadServer', state: 'CONFIRMED', reason: 'Album path confirmed.' },
            { method: 'photos.save', state: 'NOT_CHECKED', reason: 'Диагностика не загружает файлы.' },
            { method: 'wall.post', state: 'NOT_CHECKED', reason: 'Проверка ничего не публикует.' },
            { method: 'stories.getPhotoUploadServer', state: 'NOT_IMPLEMENTED', reason: 'Stories не реализованы.' },
            { method: 'stories.save', state: 'NOT_IMPLEMENTED', reason: 'Stories не реализованы.' }
          ]
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
  const albumField = form.locator('[data-vk-album-field]');
  assert.equal(await albumField.isHidden(), true);

  await form.locator('input[name="destinationKind"][value="COMMUNITY"]').check();
  assert.equal(await albumField.isVisible(), true);
  await form.locator('input[name="name"]').fill('KEY-03 Album');
  await form.locator('input[name="groupId"]').fill('67890');
  await form.locator('input[name="albumId"]').fill('777');
  await form.locator('input[name="accessToken"]').fill('browser-key-03-secret');

  await form.locator('#operator-test-connect').click();
  const card = form.locator('#operator-connect-result');
  await card.getByText(/Действительность ключа подтверждена/).waitFor();
  const cardText = await card.textContent();
  assert.match(cardText, /photos\.getWallUploadServer/);
  assert.match(cardText, /Метод отказал/);
  assert.match(cardText, /photos\.getUploadServer/);
  assert.match(cardText, /Подтверждено/);
  assert.match(cardText, /Загрузка изображений:\s*ALBUM/);
  assert.match(cardText, /Публикация доступна через album image path VK/);
  assert.equal(await form.locator('#operator-save-connect').textContent(), 'Сохранить подключение');
  assert.equal(await form.locator('#operator-save-connect').isEnabled(), true);

  await form.locator('#operator-save-connect').click();
  await page.getByText('KEY-03 Album', { exact: true }).waitFor();

  const row = db.prepare("SELECT * FROM social_accounts WHERE name='KEY-03 Album'").get();
  assert.ok(row);
  assert.equal(row.enabled, 1);
  assert.equal(row.credentials_encrypted.includes('browser-key-03-secret'), false);
  const stored = decryptJson(row.credentials_encrypted);
  assert.equal(stored.authKind, 'USER');
  assert.equal(stored.destinationKind, 'COMMUNITY');
  assert.equal(stored.groupId, '67890');
  assert.equal(stored.albumId, '777');
  assert.equal(stored.imageUploadMode, 'ALBUM');
  assert.equal(stored.accessToken, 'browser-key-03-secret');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Соцсети');
  const savedRow = page.locator(`.operator-connection[data-account-id="${row.id}"]`);
  await savedRow.waitFor({ state: 'visible' });
  assert.match(await savedRow.textContent(), /Включено/);
  assert.equal((await page.content()).includes('browser-key-03-secret'), false);

  const accounts = await page.evaluate(async () => {
    const response = await fetch('/api/accounts');
    return await response.json();
  });
  assert.equal(JSON.stringify(accounts).includes('browser-key-03-secret'), false);
  assert.ok(testBodies.length >= 2, 'save must repeat the verified capability check');
  assert.deepEqual(pageErrors, []);

  await context.close();
  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'KEY-03-BROWSER',
    albumFieldCommunityOnly: true,
    albumModeVisible: true,
    activeAfterReload: true,
    serverSideAlbumCredentials: true,
    secretAbsentFromDomAndApi: true
  }));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
