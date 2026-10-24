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

  await fs.mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/p0-composer-desktop.png', fullPage: true });
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
  await mp.screenshot({ path: 'test-results/p0-composer-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  await mobile.close();
  console.log(JSON.stringify({
    ok: true, oneScreen: true, preSaveImages: true, mediaCount: 2,
    multiAccount: 3, samePlatformAccounts: 2, noRequiredTitle: true,
    textOnly: true, cancelledSend: true, noPublicPost: true, mobile: true,
    screenshots: ['test-results/p0-composer-desktop.png', 'test-results/p0-composer-mobile.png']
  }));
} finally {
  if (browser) await browser.close();
  await app.close();
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
}
