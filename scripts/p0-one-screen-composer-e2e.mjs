import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-quick-composer-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'composer-e2e-legacy-password-2026';
process.env.APP_MASTER_KEY = 'composer-e2e-master-key-over-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:18889';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
migrate();

const accounts = [];
for (let i = 0; i < 11; i += 1) {
  const platform = i < 2 ? 'telegram' : 'vk';
  const accountId = id('acc');
  const token = platform === 'telegram'
    ? { botToken: '123456:TESTBOT' + i, chatId: '@testchannel' + i }
    : { accessToken: 'test-token-' + i, destinationKind: 'COMMUNITY', groupId: String(200000 + i), authKind: 'COMMUNITY' };
  db.prepare('INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
    .run(accountId,platform, 'Account ' + i, encryptJson(token), nowIso(), nowIso());
  accounts.push({ id: accountId, platform });
}

const app = await buildApp();
await app.listen({ port: 18889, host: '127.0.0.1' });
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();
  const errors = [];
  async function closeComposer() {
    const acceptIfAsked = (dialog) => dialog.accept();
    page.on('dialog', acceptIfAsked);
    try {
      await page.locator('#qc-close').click();
    } finally {
      page.off('dialog', acceptIfAsked);
    }
  }
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('http://127.0.0.1:18889/');
  await page.locator('#login-form:not(.hidden)').waitFor();
  await page.locator('#password').fill('composer-e2e-legacy-password-2026');
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#app:not(.hidden)').waitFor();
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').waitFor();

  assert.equal(await page.locator('#qc-files').count(), 1,
    'image upload must be visible before any draft save');
  assert.equal(await page.locator('input[name="qc-account"]').count(), 11,
    'all connected accounts must be available before any save');
  assert.equal(await page.locator('input[name="title"]:visible').count(), 0,
    'internal title must not be a mandatory user input');
  assert.equal(await page.locator('.qc-advanced:not([open])').count(), 1,
    'project and scheduling are secondary');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0,
    'opening the composer never creates a draft');

  const image1 = await sharp({ create: { width: 120, height: 110, channels: 3, background: '#ff6600' } }).png().toBuffer();
  const image2 = await sharp({ create: { width: 160, height: 130, channels: 3, background: '#0055ff' } }).png().toBuffer();
  await page.locator('#qc-text').fill('Наша новая публикация\n\nВторой абзац для нескольких площадок.');
  await page.locator('#qc-files').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: image1 },
    { name: 'second.png', mimeType: 'image/png', buffer: image2 }
  ]);
  assert.equal(await page.locator('.qc-image').count(), 2);
  for (const account of [accounts[0], accounts[1], accounts[2]]) {
    await page.locator('input[name="qc-account"][value="' + account.id + '"]').check();
  }
  assert.match(await page.locator('#qc-counter').textContent(), /3 выбрано/);
  await fs.mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/p0-composer-desktop.png', fullPage: false });
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });

  const post = db.prepare('SELECT id,title,body,status,content_format FROM posts LIMIT 1').get();
  assert.ok(post?.id, 'post created');
  assert.equal(post.title, 'Наша новая публикация');
  assert.equal(post.status, 'DRAFT');
  assert.equal(post.content_format, 'CAROUSEL');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(post.id).n,2);
  const selected = db.prepare('SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1 ORDER BY account_id')
    .all(post.id).map((row) => row.account_id);
  assert.deepEqual(selected, [accounts[0], accounts[1], accounts[2]].map(x => x.id).sort(),
    'one post selected across 2 Telegram + 1 VK account; other 8 were not selected');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, 1, 'no duplicate post');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM publication_events WHERE event_type LIKE '%publish%'").get().n, 0,
    'saving must not publish outside the application');

  // Media order remains editable after the initial save and must reach the server.
  const initialOrder = db.prepare('SELECT id FROM media WHERE post_id=? ORDER BY sort_order,created_at').all(post.id)
    .map((row) => row.id);
  assert.equal(initialOrder.length, 2);
  await page.locator('.qc-image').nth(1).getByRole('button', { name: 'Переместить раньше' }).click();
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  assert.deepEqual(
    db.prepare('SELECT id FROM media WHERE post_id=? ORDER BY sort_order,created_at').all(post.id).map((row) => row.id),
    [...initialOrder].reverse(), 'editing media order after saving must update persisted order'
  );

  await page.locator('#qc-close').click();
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Обычный текст без фотографий.');
  assert.equal(await page.locator('.qc-image').count(), 0);
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  const textOnly = db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all().find(x => x.id !== post.id);
  assert.equal(textOnly?.content_format, 'TEXT_ONLY');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(textOnly.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, 2);

  await page.locator('#qc-close').click();
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Сначала выберите площадки');
  await page.locator('#qc-send').click();
  assert.match(await page.locator('#qc-status').textContent(), /Выберите хотя бы одно/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n,2);
  await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').check();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#qc-send').click();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n,2,
    'cancelled confirmation must never create a post or contact provider');

  // Escape and the close button must protect unpublished/unsaved user input.
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#qc-close').click();
  assert.equal(await page.locator('#qc-text').isVisible(), true, 'dismissed close preserves unsaved content');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#qc-text').isVisible(), true, 'dismissed Escape preserves unsaved content');
  await closeComposer();

  // P1 regression: the confirmation for account A must never turn into a send to B,
  // even if the DOM is changed programmatically during a delayed /api/posts response.
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Снимок получателей для проверки безопасной публикации');
  await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').check();
  let startCreate;
  const createReached = new Promise((resolve) => { startCreate = resolve; });
  let resumeCreate;
  const createGate = new Promise((resolve) => { resumeCreate = resolve; });
  await page.route('**/api/posts', async (route) => {
    if (route.request().method() === 'POST') {
      startCreate();
      await createGate;
    }
    await route.continue();
  });
  let interceptedPublish = 0;
  await page.route('**/api/posts/*/publish-now', async (route) => {
    interceptedPublish += 1;
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ post: { status: 'PUBLISHED' } }) });
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#qc-send').click();
  await createReached;
  assert.equal(await page.locator('input[name="qc-account"][value="' + accounts[1].id + '"]').isDisabled(),
    true, 'recipient selection is locked while the confirmed operation runs');
  await page.evaluate((accountId) => {
    const input = [...document.querySelectorAll('input[name="qc-account"]')]
      .find((element) => element.value === accountId);
    input.checked = true; // Explicitly bypass browser disabled behavior to verify snapshot isolation.
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, accounts[1].id);
  resumeCreate();
  await page.locator('#qc-status').filter({ hasText: /Черновик сохранён:|Публикация обработана/ })
    .waitFor({ timeout: 30000 });
  const p1PostId = db.prepare('SELECT id FROM posts ORDER BY rowid DESC LIMIT 1').get().id;
  assert.deepEqual(db.prepare('SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1')
    .all(p1PostId).map((row) => row.account_id).sort(), [accounts[0].id],
    'confirmed account A must be the only persisted recipient');
  assert.ok(interceptedPublish <= 1, 'publish-now must not be repeated automatically');
  await page.unroute('**/api/posts');
  await page.unroute('**/api/posts/*/publish-now');
  await closeComposer();

  // P2 regression: saved AT draft retry must preserve the project timezone and UTC instant.
  const projectId = id('prj');
  db.prepare('INSERT INTO projects(id,name,slug,default_timezone,created_at) VALUES(?,?,?,?,?)')
    .run(projectId, 'Москва', 'tz-moscow-composer', 'Europe/Moscow', nowIso());
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Запланированное сообщение Москвы');
  await page.locator('.qc-advanced summary').click();
  await page.locator('#qc-project').selectOption(projectId);
  await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').check();
  await page.locator('#qc-datetime').fill('2026-11-12T10:00');
  const imageForRetry = await sharp({ create: { width: 100, height: 100, channels: 3,
    background: '#99bbdd' } }).png().toBuffer();
  await page.locator('#qc-files').setInputFiles([
    { name: 'first-attempt.png', mimeType: 'image/png', buffer: imageForRetry }
  ]);
  let failedOnce = false;
  await page.route('**/api/posts/*/media', async (route) => {
    if (!failedOnce && route.request().method() === 'POST') {
      failedOnce = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    } else {
      await route.continue();
    }
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#qc-schedule').click();
  await page.locator('#qc-status').filter({ hasText: /HTTP 503/ }).waitFor({ timeout: 30000 });
  assert.equal(failedOnce, true);
  const atPost = db.prepare('SELECT id,schedule_mode,schedule_timezone,scheduled_at_utc FROM posts WHERE project_id=?')
    .get(projectId);
  assert.equal(atPost.schedule_mode, 'AT');
  assert.equal(atPost.schedule_timezone, 'Europe/Moscow');
  assert.equal(atPost.scheduled_at_utc, '2026-11-12T07:00:00.000Z');
  await page.unroute('**/api/posts/*/media');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#qc-schedule').click();
  await page.locator('#qc-status').filter({ hasText: /Черновик сохранён:|Публикация запланирована/ })
    .waitFor({ timeout: 30000 });
  const afterRetry = db.prepare('SELECT id,schedule_timezone,scheduled_at_utc FROM posts WHERE project_id=?').get(projectId);
  assert.deepEqual(afterRetry, {
    id: atPost.id, schedule_timezone: 'Europe/Moscow',
    scheduled_at_utc: '2026-11-12T07:00:00.000Z'
  }, 'retry must patch same draft without UTC drift or duplicate');
  await closeComposer();

  // DST ambiguity must not silently choose an instant; an explicit user choice is required.
  const dstProjectId = id('prj');
  db.prepare('INSERT INTO projects(id,name,slug,default_timezone,created_at) VALUES(?,?,?,?,?)')
    .run(dstProjectId, 'Нью-Йорк', 'tz-ny-composer', 'America/New_York', nowIso());
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Проверка неоднозначного времени');
  await page.locator('.qc-advanced summary').click();
  await page.locator('#qc-project').selectOption(dstProjectId);
  await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').check();
  await page.locator('#qc-datetime').fill('2026-11-01T01:30');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#qc-schedule').click();
  await page.locator('#qc-status').filter({ hasText: /ambiguous/ }).waitFor({ timeout: 30000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts WHERE project_id=?').get(dstProjectId).n, 0,
    'ambiguous local time without offset cannot create a post');
  await page.locator('#qc-ambiguous').selectOption('earlier');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#qc-schedule').click();
  await page.locator('#qc-status').filter({ hasText: /Черновик сохранён:|Публикация запланирована/ })
    .waitFor({ timeout: 30000 });
  const dstPost = db.prepare('SELECT schedule_timezone,scheduled_at_utc FROM posts WHERE project_id=?').get(dstProjectId);
  assert.equal(dstPost.schedule_timezone, 'America/New_York');
  assert.equal(dstPost.scheduled_at_utc, '2026-11-01T05:30:00.000Z');
  await closeComposer();

  assert.deepEqual(errors, []);
  await desktop.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true
  });
  const mp = await mobile.newPage();
  mp.on('pageerror', (error) => errors.push(String(error)));
  await mp.goto('http://127.0.0.1:18889/');
  await mp.locator('#login-form:not(.hidden)').waitFor();
  await mp.locator('#password').fill('composer-e2e-legacy-password-2026');
  await mp.locator('#login-form button[type="submit"]').click();
  await mp.locator('#app:not(.hidden)').waitFor();
  await mp.locator('.ui-mobile-menu').click();
  await mp.locator('#quick-compose-nav').click();
  await mp.locator('#qc-text').waitFor();
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'mobile must not overflow horizontally');
  assert.equal(await mp.locator('input[name="qc-account"]').count(),11);
  await mp.locator('#qc-text').fill('Новая публикация для всех подключений.');
  await mp.locator('#qc-files').setInputFiles([{ name: 'mobile.png', mimeType: 'image/png', buffer: image1 }]);
  await mp.screenshot({ path: 'test-results/p0-composer-mobile.png', fullPage: false });
  await mp.locator('.qc-right').scrollIntoViewIfNeeded();
  await mp.screenshot({ path: 'test-results/p0-composer-mobile-targets.png', fullPage: false });
  assert.deepEqual(errors, []);
  await mobile.close();
  console.log(JSON.stringify({
    ok: true, oneScreen: true, preSaveImages: true, mediaCount: 2,
    multiAccount: 3, samePlatformAccounts: 2, noRequiredTitle: true,
    textOnly: true, cancelledSend: true, noPublicPost: true, mobile: true,
    screenshots: ['test-results/p0-composer-desktop.png', 'test-results/p0-composer-mobile.png', 'test-results/p0-composer-mobile-targets.png']
  }));
} finally {
  if (browser) await browser.close();
  await app.close();
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
}
