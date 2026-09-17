import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-browser-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'browser-acceptance-password';
process.env.APP_MASTER_KEY = 'browser-acceptance-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:18087';

const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();
await app.listen({ host: '127.0.0.1', port: 18087 });

const base = 'http://127.0.0.1:18087';
const routes = new Map([
  ['/overview', 'Обзор'], ['/calendar', 'Календарь'], ['/content', 'Контент'],
  ['/library', 'Библиотека'], ['/templates', 'Шаблоны'], ['/projects', 'Проекты'],
  ['/socials', 'Соцсети'], ['/sources', 'Источники / Интеграции'], ['/schedule', 'Расписание'],
  ['/journal', 'Журнал'], ['/backups', 'Резервные копии'], ['/diagnostics', 'Диагностика']
]);
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));

  await page.goto(`${base}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).pathname, '/calendar', 'direct route must survive unauthenticated bootstrap');
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Календарь');
  assert.equal(new URL(page.url()).pathname, '/calendar', 'login must return to requested route');

  for (const [route, title] of routes) {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.waitForFunction((expected) => document.querySelector('#page-title')?.textContent?.trim() === expected, title);
    assert.equal(new URL(page.url()).pathname, route, `wrong browser route for ${route}`);
    assert.equal(await page.locator(`[data-route="${route}"].active`).count(), 1, `active nav missing for ${route}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${route} desktop body overflow: ${overflow}px`);
  }
  await page.goto(`${base}/sources`, { waitUntil: 'domcontentloaded' });
  await page.locator('#operator-google-sheets-live').waitFor({ state: 'visible' });
  const sourcesText = await page.locator('#view').innerText();
  for (const stale of ['Пока не подключено', 'backend ещё не реализован', 'Cloud media connectors пока не включены']) {
    assert.ok(!sourcesText.includes(stale), `stale Sources copy is visible: ${stale}`);
  }
  assert.match(sourcesText, /Google Sheets/, 'Google Sheets live source section is missing');
  assert.match(sourcesText, /Google Drive \/ Яндекс Диск/, 'cloud media source card is missing');

  await page.goto(`${base}/overview`, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('[data-route="/calendar"]').click();
  await page.waitForURL('**/calendar');
  await page.locator('[data-route="/content"]').click();
  await page.waitForURL('**/content');
  await page.goBack();
  await page.waitForURL('**/calendar');
  assert.equal((await page.locator('#page-title').textContent())?.trim(), 'Календарь');
  await page.goForward();
  await page.waitForURL('**/content');
  assert.equal((await page.locator('#page-title').textContent())?.trim(), 'Контент');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['/overview','/calendar','/content','/library','/socials','/sources']) {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.waitForFunction((expected) => document.querySelector('#page-title')?.textContent?.trim() === expected, routes.get(route));
    const metrics = await page.evaluate(() => ({
      htmlOverflow: document.documentElement.scrollWidth - window.innerWidth,
      bodyOverflow: document.body.scrollWidth - window.innerWidth
    }));
    assert.ok(metrics.htmlOverflow <= 1, `${route} mobile html overflow: ${metrics.htmlOverflow}px`);
    assert.ok(metrics.bodyOverflow <= 1, `${route} mobile body overflow: ${metrics.bodyOverflow}px`);
  }

  assert.deepEqual(pageErrors, [], `browser page errors:\n${pageErrors.join('\n')}`);
  await context.close();
  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'FE-SAFETY-001',
    desktopRoutes: routes.size,
    mobileRoutes: 6,
    directRouteLogin: true,
    browserHistory: true,
    noBodyOverflow: true,
    pageErrors: 0
  }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
