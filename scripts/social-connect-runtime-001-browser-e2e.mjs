import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-social-connect-browser-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'social-connect-browser-password';
process.env.APP_MASTER_KEY = 'social-connect-browser-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:18089';

const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();
await app.listen({ host: '127.0.0.1', port: 18089 });

const base = 'http://127.0.0.1:18089';
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const testBodies = [];
  const inspectionBodies = [];
  const saveBodies = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));

  await page.route('**/api/vk/token/inspect', async (route) => {
    const body = route.request().postDataJSON();
    inspectionBodies.push(body);
    const communityKey = body.credentials.accessToken === 'vk-community-token';
    if (body.credentials.accessToken === 'vk-ip-token') {
      await route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ error: 'VK отклонил ключ: он привязан к другому IP-адресу.' }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(communityKey
        ? { valid: true, authKind: 'COMMUNITY', identity: 'Test Community',
            permissions: ['photos', 'wall'], groupId: '67890', groupName: 'Test Community' }
        : { valid: true, authKind: 'USER', identity: 'Test User', userId: '12345' })
    });
  });

  await page.route('**/api/accounts/test', async (route) => {
    const request = route.request();
    assert.equal(request.method(), 'POST');
    const body = request.postDataJSON();
    testBodies.push(body);
    if (body.platform === 'vk' && body.credentials.accessToken === 'vk-no-owner-token') {
      await route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ error: 'VK: users.get не вернул владельца User access token' }) });
      return;
    }
    let response;
    if (body.platform === 'vk' && body.credentials.destinationKind === 'PERSONAL') {
      response = {
        ok: true,
        platform: 'vk',
        identity: 'Личная страница · Test User',
        destination: 'https://vk.com/id12345',
        details: {
          apiVersion: '5.199',
          authKind: 'USER',
          authenticatedUserId: '12345',
          authenticatedUserName: 'Test User',
          destinationKind: 'PERSONAL',
          destinationId: '12345',
          destinationName: 'Test User',
          destinationScreenName: 'id12345',
          keyValidity: 'CONFIRMED',
          permissions: [],
          permissionsSource: 'NOT_CONFIRMED_FOR_USER_KEY',
          destinationStatus: 'CONFIRMED',
          destinationOwnershipConfirmed: true,
          publishReady: true,
          wallPhotoReady: true,
          wallUploadReady: true,
          wallPostNotExecuted: true
        }
      };
    } else if (body.platform === 'vk' && body.credentials.destinationKind === 'COMMUNITY') {
      response = {
        ok: true,
        platform: 'vk',
        identity: 'Сообщество · Test Community',
        destination: 'https://vk.com/club67890',
        details: {
          apiVersion: '5.199',
          authKind: 'USER',
          authenticatedUserId: '12345',
          authenticatedUserName: 'Test User',
          destinationKind: 'COMMUNITY',
          destinationId: '67890',
          destinationName: 'Test Community',
          destinationScreenName: 'club67890',
          keyValidity: 'CONFIRMED',
          permissions: [],
          permissionsSource: 'NOT_CONFIRMED_FOR_USER_KEY',
          destinationStatus: 'CONFIRMED',
          destinationOwnershipConfirmed: false,
          publishReady: true,
          wallPhotoReady: true,
          wallUploadReady: true,
          wallPostNotExecuted: true
        }
      };
    } else if (body.platform === 'telegram') {
      response = { ok: true, platform: 'telegram', identity: '@test_bot', destination: '@test_channel' };
    } else if (body.platform === 'instagram') {
      response = { ok: true, platform: 'instagram', identity: '@test_instagram', destination: 'ig-123' };
    } else {
      response = { ok: true, platform: body.platform, identity: 'test', destination: 'test' };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });

  await page.route('**/api/accounts', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.continue();
      return;
    }
    const body = request.postDataJSON();
    saveBodies.push(body);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: `mock-${saveBodies.length}`, platform: body.platform, name: body.name, enabled: true })
    });
  });

  await page.goto(`${base}/socials`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login').waitFor({ state: 'visible' });
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Соцсети');
  assert.equal(new URL(page.url()).pathname, '/socials');

  async function openPlatform(platform) {
    await page.goto(`${base}/socials`, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Соцсети');
    await page.locator(`.operator-platform-card[data-platform="${platform}"] .operator-add-platform`).click();
    const form = page.locator('#operator-social-form');
    await form.waitFor({ state: 'visible' });
    return form;
  }

  // VK PERSONAL.
  {
    const form = await openPlatform('vk');
    assert.equal(await form.locator('input[name="destinationKind"][value="PERSONAL"]').count(), 1);
    assert.equal(await form.locator('input[name="destinationKind"][value="COMMUNITY"]').count(), 1);
    assert.equal(await form.getByText('Личная страница', { exact: true }).count(), 1);
    assert.equal(await form.getByText('Сообщество', { exact: true }).count(), 1);
    const groupField = form.locator('[data-vk-community-field]');
    const groupInput = form.locator('input[name="groupId"]');
    const communityAuthHint = form.locator('[data-vk-community-auth-hint]');
    assert.equal(await groupField.isHidden(), true);
    assert.equal(await communityAuthHint.isHidden(), true);
    assert.equal(await groupInput.evaluate((element) => element.required), false);
    assert.equal(await form.locator('input[name="apiVersion"]').inputValue(), '5.199');

    await form.locator('input[name="name"]').fill('VK Personal');
    await form.locator('input[name="accessToken"]').fill('vk-personal-token');
    const beforeTest = testBodies.length;
    await form.locator('#operator-test-connect').click();
    await form.locator('#operator-save-connect').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#operator-save-connect')?.disabled === false);
    assert.equal(testBodies.length, beforeTest + 1);
    assert.deepEqual(testBodies.at(-1), {
      platform: 'vk',
      credentials: {
        accessToken: 'vk-personal-token',
        apiVersion: '5.199',
        destinationKind: 'PERSONAL'
      }
    });

    const saveRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname === '/api/accounts' && request.method() === 'POST'
    );
    await form.locator('#operator-save-connect').click();
    const request = await saveRequest;
    const saved = request.postDataJSON();
    assert.equal(saved.platform, 'vk');
    assert.equal(saved.credentials.authKind, 'USER');
    assert.equal(saved.credentials.destinationKind, 'PERSONAL');
    assert.equal(saved.credentials.userId, '12345');
    assert.equal(saved.credentials.destinationName, 'Test User');
    assert.equal(saved.credentials.apiVersion, '5.199');
    assert.equal('groupId' in saved.credentials, false);
  }

  // VK COMMUNITY.
  {
    const form = await openPlatform('vk');
    await form.locator('input[name="destinationKind"][value="COMMUNITY"]').check();
    const groupField = form.locator('[data-vk-community-field]');
    const groupInput = form.locator('input[name="groupId"]');
    const communityAuthHint = form.locator('[data-vk-community-auth-hint]');
    assert.equal(await groupField.isVisible(), true);
    assert.equal(await communityAuthHint.isVisible(), true);
    assert.match(await communityAuthHint.textContent(), /пользователь/);
    assert.match(await communityAuthHint.textContent(), /Ключ сообщества/);
    assert.equal(await groupInput.evaluate((element) => element.required), false);
    await form.locator('input[name="name"]').fill('VK Community');
    await form.locator('input[name="accessToken"]').fill('vk-community-user-token');
    await groupInput.fill('https://vk.com/club67890');

    const beforeTest = testBodies.length;
    await form.locator('#operator-test-connect').click();
    await page.waitForFunction(() => document.querySelector('#operator-save-connect')?.disabled === false);
    assert.equal(testBodies.length, beforeTest + 1);
    assert.deepEqual(testBodies.at(-1), {
      platform: 'vk',
      credentials: {
        accessToken: 'vk-community-user-token',
        apiVersion: '5.199',
        destinationKind: 'COMMUNITY',
        groupId: 'https://vk.com/club67890'
      }
    });

    const saveRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname === '/api/accounts' && request.method() === 'POST'
    );
    await form.locator('#operator-save-connect').click();
    const saved = (await saveRequest).postDataJSON();
    assert.equal(saved.credentials.authKind, 'USER');
    assert.equal(saved.credentials.destinationKind, 'COMMUNITY');
    assert.equal(saved.credentials.groupId, '67890');
    assert.equal(saved.credentials.destinationName, 'Test Community');
    assert.equal(saved.credentials.apiVersion, '5.199');
    assert.equal('userId' in saved.credentials, false);
  }

  // A valid community key can be saved without becoming a publication target.
  {
    const form = await openPlatform('vk');
    await form.locator('input[name="name"]').fill('VK Group Key');
    await form.locator('input[name="accessToken"]').fill('vk-community-token');
    const beforeTest = testBodies.length;
    const beforeSave = saveBodies.length;
    await form.locator('#operator-test-connect').click();
    await page.waitForFunction(() => document.querySelector('#operator-save-connect')?.disabled === false);
    assert.match(await form.locator('#operator-connect-result').textContent(), /Ключ сообщества действителен/);
    assert.equal(await form.locator('input[name="groupId"]').inputValue(), '67890');
    assert.equal(await form.locator('#operator-save-connect').textContent(), 'Сохранить ключ VK');
    assert.equal(testBodies.length, beforeTest);
    assert.equal(saveBodies.length, beforeSave);
    const saveRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname === '/api/accounts' && request.method() === 'POST'
    );
    await form.locator('#operator-save-connect').click();
    const saved = (await saveRequest).postDataJSON();
    assert.equal(saved.credentials.authKind, 'COMMUNITY');
    assert.equal(saved.credentials.groupId, '67890');
    assert.equal(saved.credentials.accessToken, 'vk-community-token');
    assert.equal(inspectionBodies.at(-1).credentials.accessToken, 'vk-community-token');
  }

  // VK errors must not block encrypted, disabled key storage.
  for (const [token, errorText] of [
    ['vk-no-owner-token', /users.get не вернул владельца/],
    ['vk-ip-token', /другому IP-адресу/]
  ]) {
    const form = await openPlatform('vk');
    await form.locator('input[name="destinationKind"][value="COMMUNITY"]').check();
    await form.locator('input[name="groupId"]').fill('234601853');
    await form.locator('input[name="accessToken"]').fill(token);
    assert.equal(await form.locator('#operator-save-connect').isEnabled(), true);
    await form.locator('#operator-test-connect').click();
    await form.locator('#operator-connect-result .operator-result.error').waitFor();
    assert.match(await form.locator('#operator-connect-result').textContent(), errorText);
    assert.equal(await form.locator('#operator-save-connect').isEnabled(), true);
    const saveRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname === '/api/accounts' && request.method() === 'POST'
    );
    await form.locator('#operator-save-connect').click();
    const saved = (await saveRequest).postDataJSON();
    assert.equal(saved.name, 'VK 234601853');
    assert.equal(saved.credentials.authKind, 'PENDING');
    assert.equal(saved.credentials.accessToken, token);
    assert.equal(saved.credentials.groupId, '234601853');
  }

  // Telegram remains canonical and does not use the VK destination contract.
  {
    const form = await openPlatform('telegram');
    assert.equal(await form.locator('input[name="botToken"]').count(), 1);
    assert.equal(await form.locator('input[name="chatId"]').count(), 1);
    await form.locator('input[name="name"]').fill('Telegram Test');
    await form.locator('input[name="botToken"]').fill('123456:TEST');
    await form.locator('input[name="chatId"]').fill('@test_channel');
    await form.locator('#operator-test-connect').click();
    await page.waitForFunction(() => document.querySelector('#operator-save-connect')?.disabled === false);
    const saveRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname === '/api/accounts' && request.method() === 'POST'
    );
    await form.locator('#operator-save-connect').click();
    const saved = (await saveRequest).postDataJSON();
    assert.deepEqual(saved.credentials, { botToken: '123456:TEST', chatId: '@test_channel' });
  }

  // Instagram remains canonical and does not use the VK networking contract.
  {
    const form = await openPlatform('instagram');
    assert.equal(await form.locator('input[name="accessToken"]').count(), 1);
    assert.equal(await form.locator('input[name="igUserId"]').count(), 1);
    assert.equal(await form.locator('input[name="graphVersion"]').count(), 1);
    await form.locator('input[name="name"]').fill('Instagram Test');
    await form.locator('input[name="accessToken"]').fill('instagram-token');
    await form.locator('input[name="igUserId"]').fill('ig-user-123');
    await form.locator('input[name="graphVersion"]').fill('v24.0');
    await form.locator('#operator-test-connect').click();
    await page.waitForFunction(() => document.querySelector('#operator-save-connect')?.disabled === false);
    const saveRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname === '/api/accounts' && request.method() === 'POST'
    );
    await form.locator('#operator-save-connect').click();
    const saved = (await saveRequest).postDataJSON();
    assert.deepEqual(saved.credentials, {
      accessToken: 'instagram-token',
      igUserId: 'ig-user-123',
      graphVersion: 'v24.0'
    });
  }

  for (let attempt = 0; attempt < 100 && saveBodies.length < 7; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(saveBodies.length, 7, 'all mocked account-create handlers must complete');
  assert.deepEqual(pageErrors, [], `browser page errors:\n${pageErrors.join('\n')}`);
  await context.close();

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'SOCIAL-CONNECT-RUNTIME-001',
    canonicalRoute: '/socials',
    vkPersonalUi: true,
    vkCommunityUi: true,
    vkPersonalSavePayload: true,
    vkCommunitySavePayload: true,
    telegramUiPayload: true,
    instagramUiPayload: true,
    externalCallsMocked: true
  }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
