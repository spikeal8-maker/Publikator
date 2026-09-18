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

const fixtureLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(fixtureLogin.statusCode, 200, fixtureLogin.body);
const fixtureCookie = String(fixtureLogin.headers['set-cookie']).split(';')[0];
const fixtureProjectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get()?.id;
assert.ok(fixtureProjectId, 'browser Library fixture project missing');

async function createLibraryPresentationFixture(title, { publicationKind, contentFormat, sourceType, editorialStage, status }) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/posts',
    headers: { cookie: fixtureCookie },
    payload: {
      projectId: fixtureProjectId,
      title,
      body: `${title} body`,
      scheduleMode: 'MANUAL'
    }
  });
  assert.equal(response.statusCode, 201, response.body);
  const post = response.json();
  db.prepare('UPDATE posts SET publication_kind=?,content_format=?,source_type=?,editorial_stage=?,status=? WHERE id=?')
    .run(publicationKind, contentFormat, sourceType, editorialStage, status, post.id);
  return post.id;
}

const libraryFixtureATitle = 'Browser Library Presentation A';
const libraryFixtureAId = await createLibraryPresentationFixture(libraryFixtureATitle, {
  publicationKind: 'FEED',
  contentFormat: 'IMAGE',
  sourceType: 'google_sheets',
  editorialStage: 'IN_REVIEW',
  status: 'DRAFT'
});
const libraryFixtureStoryTitle = 'Browser Library Story Sequence';
await createLibraryPresentationFixture(libraryFixtureStoryTitle, {
  publicationKind: 'STORY',
  contentFormat: 'STORY_SEQUENCE',
  sourceType: 'manual',
  editorialStage: 'IDEA',
  status: 'DRAFT'
});

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

  await page.goto(`${base}/library`, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Библиотека');
  await page.locator('.content-library').waitFor({ state: 'visible' });
  const libraryViewLabels = {
    all: 'Все',
    inbox: 'Входящие',
    draft: 'Черновики',
    ready: 'Готово',
    scheduled: 'Запланировано',
    published: 'Опубликовано',
    problems: 'Проблемы'
  };
  for (const [key, label] of Object.entries(libraryViewLabels)) {
    assert.equal((await page.locator(`[data-library-view="${key}"]`).textContent())?.trim(), label, `Library view label mismatch for ${key}`);
  }
  assert.equal((await page.locator('[data-layout="grid"]').textContent())?.trim(), 'Карточки', 'Library grid layout label mismatch');
  assert.equal((await page.locator('[data-layout="list"]').textContent())?.trim(), 'Таблица', 'Library list layout label mismatch');
  const libraryFormatLabels = {
    all: 'Все форматы',
    image: 'Изображения',
    stories: 'Истории',
    shorts: 'Короткие видео',
    video: 'Видео'
  };
  for (const [key, label] of Object.entries(libraryFormatLabels)) {
    assert.equal((await page.locator(`#library-format option[value="${key}"]`).textContent())?.trim(), label, `Library format label mismatch for ${key}`);
  }

  const searchLibrary = async (title, selector) => {
    await page.locator('#library-search').fill(title);
    await page.locator('#library-search').press('Enter');
    await page.waitForFunction(({ expectedTitle, expectedSelector }) => {
      return [...document.querySelectorAll(expectedSelector)].some((node) => node.textContent?.includes(expectedTitle));
    }, { expectedTitle: title, expectedSelector: selector });
  };

  await searchLibrary(libraryFixtureATitle, '.library-card');
  let fixtureCard = page.locator('.library-card').filter({ hasText: libraryFixtureATitle });
  assert.equal(await fixtureCard.count(), 1, 'Library presentation fixture A must render once in grid');
  let fixtureText = await fixtureCard.innerText();
  for (const expected of ['Пост · Изображение', 'Источник: Google Sheets', 'Контент · На проверке', 'Публикация · Черновик']) {
    assert.ok(fixtureText.includes(expected), `Library grid fixture missing: ${expected}`);
  }
  for (const forbidden of ['FEED / IMAGE', 'source:', 'google_sheets', 'IN_REVIEW', 'DRAFT']) {
    assert.ok(!fixtureText.includes(forbidden), `Library grid fixture exposes raw presentation text: ${forbidden}`);
  }
  const gridContentBadge = fixtureCard.locator('.badge[data-status-role="Контент"]');
  const gridPublicationBadge = fixtureCard.locator('.badge[data-status-role="Публикация"]');
  assert.equal(await gridContentBadge.getAttribute('data-raw-status'), 'IN_REVIEW');
  assert.equal(await gridPublicationBadge.getAttribute('data-raw-status'), 'DRAFT');
  assert.equal(await gridContentBadge.getAttribute('data-presentation-owner'), 'library');
  assert.equal(await gridPublicationBadge.getAttribute('data-presentation-owner'), 'library');

  await page.locator('[data-layout="list"]').click();
  await page.waitForFunction((title) => [...document.querySelectorAll('.library-table tbody tr')].some((row) => row.textContent?.includes(title)), libraryFixtureATitle);
  const fixtureRow = page.locator('.library-table tbody tr').filter({ hasText: libraryFixtureATitle });
  assert.equal(await fixtureRow.count(), 1, 'Library presentation fixture A must render once in table');
  const fixtureCells = fixtureRow.locator('td');
  assert.equal((await fixtureCells.nth(5).textContent())?.trim(), 'Пост · Изображение');
  assert.equal((await fixtureCells.nth(7).textContent())?.trim(), 'Google Sheets');
  const tableStatusText = (await fixtureCells.nth(6).innerText()).trim();
  assert.ok(tableStatusText.includes('Контент · На проверке'));
  assert.ok(tableStatusText.includes('Публикация · Черновик'));
  assert.equal(await fixtureRow.locator('.badge[data-status-role="Контент"]').getAttribute('data-raw-status'), 'IN_REVIEW');
  assert.equal(await fixtureRow.locator('.badge[data-status-role="Публикация"]').getAttribute('data-raw-status'), 'DRAFT');

  await page.locator('[data-layout="grid"]').click();
  await page.waitForFunction((id) => document.querySelector(`[data-library-select="${id}"]`)?.closest('.library-card') !== null, libraryFixtureAId);
  fixtureCard = page.locator('.library-card').filter({ hasText: libraryFixtureATitle });
  fixtureText = await fixtureCard.innerText();
  assert.ok(fixtureText.includes('Контент · На проверке'), 'Library grid ownership must survive list-to-grid rerender');
  assert.ok(fixtureText.includes('Публикация · Черновик'), 'Library publication role must survive list-to-grid rerender');

  await searchLibrary(libraryFixtureStoryTitle, '.library-card');
  const storyCard = page.locator('.library-card').filter({ hasText: libraryFixtureStoryTitle });
  assert.equal(await storyCard.count(), 1, 'Library story fixture must render once');
  assert.ok((await storyCard.innerText()).includes('Серия историй'), 'Library second format mapping missing');

  await page.goto(`${base}/overview`, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Обзор');
  await page.locator('.dashboard-v3-root').waitFor({ state: 'visible' });
  const problemsMetric = page.locator('.dashboard-v3-metric').filter({ hasText: /^Проблемы/ });
  assert.equal(await problemsMetric.count(), 1, 'Problems metric must render exactly once');
  assert.equal((await problemsMetric.locator('span').textContent())?.trim(), 'ошибки и публикации, требующие проверки', 'Problems metric note mismatch');
  assert.equal(await page.getByText('ошибки и recovery-состояния', { exact: true }).count(), 0, 'legacy Problems metric note must not be visible');

  await page.goto(`${base}/schedule`, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Расписание');
  await page.locator('#new-slot').click();
  const slotForm = page.locator('#slot-form');
  await slotForm.waitFor({ state: 'visible' });
  assert.equal((await slotForm.locator('xpath=ancestor::div[contains(@class,"modal-card")]//h2').textContent())?.trim(), 'Новое время публикации', 'schedule modal heading mismatch');
  assert.equal((await slotForm.locator('label:has([name="timezone"])').innerText()).trim(), 'Часовой пояс', 'schedule timezone label mismatch');
  assert.equal((await slotForm.locator('button.primary').textContent())?.trim(), 'Добавить', 'schedule primary action mismatch');
  await slotForm.locator('#close-modal').click();
  await page.locator('#slot-form').waitFor({ state: 'detached' });

  await page.goto(`${base}/sources`, { waitUntil: 'domcontentloaded' });
  await page.locator('#operator-google-sheets-live').waitFor({ state: 'visible' });
  const sourcesText = await page.locator('#view').innerText();
  for (const stale of ['Пока не подключено', 'backend ещё не реализован', 'Cloud media connectors пока не включены']) {
    assert.ok(!sourcesText.includes(stale), `stale Sources copy is visible: ${stale}`);
  }
  assert.match(sourcesText, /Google Sheets/, 'Google Sheets live source section is missing');
  assert.match(sourcesText, /Google Drive \/ Яндекс Диск/, 'cloud media source card is missing');
  await page.goto(`${base}/content`, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.goto(`${base}/sources`, { waitUntil: 'domcontentloaded' });
  await page.locator('#operator-google-sheets-live').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#operator-google-sheets-live').count(), 1, 'Google Sheets live section must mount exactly once after route re-entry');

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
    scheduleModalOwnership: true,
    overviewRendererOwnership: true,
    libraryControlsOwnership: true,
    libraryPresentationOwnership: true,
    noBodyOverflow: true,
    pageErrors: 0
  }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
