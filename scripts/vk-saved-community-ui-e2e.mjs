import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-saved-community-ui-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'vk-saved-community-ui-password';
process.env.APP_MASTER_KEY = 'vk-saved-community-ui-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:18091';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');

migrate();
const now = nowIso();
const personalId = id('acc');
const communityId = id('acc');

db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`).run(
  personalId,
  'vk',
  'Saved Personal',
  encryptJson({
    accessToken: 'stored-user-token',
    apiVersion: '5.199',
    authKind: 'USER',
    destinationKind: 'PERSONAL',
    userId: '123'
  }),
  now,
  now
);

db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`).run(
  communityId,
  'vk',
  'Saved Community',
  encryptJson({
    accessToken: 'stored-user-token',
    apiVersion: '5.199',
    authKind: 'USER',
    destinationKind: 'COMMUNITY',
    groupId: '999'
  }),
  now,
  now
);

const app = await buildApp();
await app.listen({ host: '127.0.0.1', port: 18091 });

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const communityRequests = [];
  let accountCreateCalls = 0;

  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/accounts' && request.method() === 'POST') accountCreateCalls += 1;
  });

  await page.route('**/api/accounts/*/vk-community/test', async (route) => {
    const request = route.request();
    communityRequests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postDataJSON()
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        platform: 'vk',
        identity: 'Сообщество · IIBUSI',
        destination: 'https://vk.com/iibusi',
        details: {
          authKind: 'USER',
          authenticatedUserId: '123',
          authenticatedUserName: 'Test User',
          destinationKind: 'COMMUNITY',
          destinationId: '234903751',
          destinationName: 'IIBUSI',
          destinationScreenName: 'iibusi',
          wallPhotoReady: true,
          wallPostNotExecuted: true
        }
      })
    });
  });

  await page.goto('http://127.0.0.1:18091/socials', { waitUntil: 'domcontentloaded' });
  await page.locator('#login').waitFor({ state: 'visible' });
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Соцсети');

  const personalRow = page.locator(`.operator-connection[data-account-id="${personalId}"]`);
  const communityRow = page.locator(`.operator-connection[data-account-id="${communityId}"]`);

  assert.equal(await personalRow.getByRole('button', { name: 'Добавить сообщество', exact: true }).count(), 1);
  assert.equal(await communityRow.getByRole('button', { name: 'Добавить сообщество', exact: true }).count(), 0);

  await personalRow.getByRole('button', { name: 'Добавить сообщество', exact: true }).click();

  const form = personalRow.locator('.operator-vk-community-test-form');
  await form.waitFor({ state: 'visible' });
  assert.equal(await form.locator('input[name="accessToken"]').count(), 0);
  assert.equal(await form.locator('input[name="groupId"]').count(), 1);
  assert.equal(await form.getByRole('button', { name: 'Сохранить', exact: false }).count(), 0);

  await form.locator('input[name="groupId"]').fill('-234903751');
  await form.getByRole('button', { name: 'Проверить', exact: true }).click();

  const result = personalRow.locator('.operator-vk-community-test-result');
  await result.getByText('Сообщество найдено', { exact: true }).waitFor({ state: 'visible' });

  assert.equal(communityRequests.length, 1);
  assert.equal(communityRequests[0].method, 'POST');
  assert.equal(communityRequests[0].path, `/api/accounts/${personalId}/vk-community/test`);
  assert.deepEqual(communityRequests[0].body, { groupId: '-234903751' });

  assert.equal(await result.getByText('IIBUSI', { exact: true }).count(), 1);
  assert.equal(await result.getByText('234903751', { exact: true }).count(), 1);
  assert.equal(await result.getByText('https://vk.com/iibusi', { exact: true }).count(), 1);
  assert.equal(await result.getByText('Готово', { exact: true }).count(), 1);
  assert.equal(accountCreateCalls, 0, 'community test UI must not create a COMMUNITY account');
  assert.deepEqual(pageErrors, [], `browser page errors:\n${pageErrors.join('\n')}`);

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'VK-SAVED-COMMUNITY-UI',
    personalButton: true,
    communityButtonAbsent: true,
    tokenFieldAbsent: true,
    endpointCalled: true,
    groupIdSent: '-234903751',
    resultName: 'IIBUSI',
    resultId: '234903751',
    resultUrl: 'https://vk.com/iibusi',
    wallPhotoReadyShown: true,
    communitySaved: false
  }, null, 2));

  await context.close();
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
