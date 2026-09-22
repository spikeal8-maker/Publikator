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
  const saveBodies = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));

  await page.route('**/api/accounts/test', async (route) => {
    const request = route.request();
    assert.equal(request.method(), 'POST');
    const body = request.postDataJSON();
    testBodies.push(body);
    let response;
    if (body.platform === 'vk' && body.credentials.destinationKind === 'PERSONAL') {
      response = {
        ok: true,
        platform: 'vk',
        identity: 'Личная страница · Test User',
        destination: 'https://vk.com/id12345',
        details: {
          apiVersion: '5.199',
          destinationKind: 'PERSONAL',
          destinationId: '12345',
          destinationName: 'Test User'
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
          destinationKind: 'COMMUNITY',
          destinationId: '67890',
          destinationName: 'Test Community'
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
    assert.equal(await groupField.isHidden(), true);
    assert.equal(await groupInput.isRequired(), false);
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
    assert.equal(await groupField.isVisible(), true);
    assert.equal(await groupInput.isRequired(), true);
    await form.locator('input[name="name"]').fill('VK Community');
    await form.locator('input[name="accessToken"]').fill('vk-community-token');
    await groupInput.fill('https://vk.com/club67890');

    const beforeTest = testBodies.length;
    await form.locator('#operator-test-connect').click();
    await page.waitForFunction(() => document.querySelector('#operator-save-connect')?.disabled === false);
    assert.equal(testBodies.length, beforeTest + 1);
    assert.deepEqual(testBodies.at(-1), {
      platform: 'vk',
      credentials: {
        accessToken: 'vk-community-token',
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
    assert.equal(saved.credentials.destinationKind, 'COMMUNITY');
    assert.equal(saved.credentials.groupId, '67890');
    assert.equal(saved.credentials.destinationName, 'Test Community');
    assert.equal(saved.credentials.apiVersion, '5.199');
    assert.equal('userId' in saved.credentials, false);
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

  assert.equal(saveBodies.length, 4);
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
