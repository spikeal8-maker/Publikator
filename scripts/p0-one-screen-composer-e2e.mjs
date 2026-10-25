import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const composerScript = await fs.readFile(new URL('../public/quick-composer-v1.js', import.meta.url), 'utf8');
assert.equal(composerScript.split("root.addEventListener('paste'").length - 1, 1,
  'the composer must install exactly one clipboard paste handler per open dialog');

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
  assert.equal(await page.locator('#qc-platform-preview-load').isDisabled(), true,
    'preview requires both content and at least one explicitly selected account');

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

  // D2: preview selected accounts using local browser-owned blobs before the
  // first server write. It is explicitly labelled unvalidated/approximate.
  const localPreviewRequests = [];
  const recordPreviewGet = (request) => {
    if (request.url().includes('/platform-previews')) localPreviewRequests.push(request.url());
  };
  page.on('request', recordPreviewGet);
  assert.equal(await page.locator('#qc-platform-preview-load').isDisabled(), false);
  assert.equal(await page.locator('#qc-platform-preview-load').textContent(), 'Предпросмотр до сохранения');
  await page.locator('#qc-platform-preview-load').click();
  await page.locator('#qc-platform-preview:not([hidden])').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#qc-platform-preview-choice option').count(), 3);
  assert.match(await page.locator('#qc-platform-preview-source').textContent(), /До сохранения.*локальный/);
  const telegramLocalOption = 'local:' + accounts[0].id;
  const vkLocalOption = 'local:' + accounts[2].id;
  await page.locator('#qc-platform-preview-choice').selectOption(telegramLocalOption);
  assert.equal(await page.locator('.qc-platform-media img').count(), 2);
  const originalLocalOrder = await page.locator('.qc-platform-media img').evaluateAll((images) =>
    images.map((img) => img.getAttribute('src')));
  assert.ok(originalLocalOrder.every((uri) => uri.startsWith('blob:')),
    'unsaved preview shows only local object URLs, not invented remote media');
  let localParts = await page.locator('#qc-platform-preview-card > *').evaluateAll((elements) =>
    elements.map((el) => el.className));
  assert.ok(localParts.indexOf('qc-platform-media') < localParts.indexOf('qc-platform-caption'),
    'local Telegram caption is below local images');
  await page.locator('#qc-platform-preview-choice').selectOption(vkLocalOption);
  localParts = await page.locator('#qc-platform-preview-card > *').evaluateAll((elements) =>
    elements.map((el) => el.className));
  assert.ok(localParts.indexOf('qc-platform-caption') < localParts.indexOf('qc-platform-media'),
    'local VK caption is above local images');
  assert.equal(localPreviewRequests.length, 0, 'pre-save preview must not fetch server renditions');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0,
    'local preview does not create a draft');
  await fs.mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/p0-composer-local-preview-desktop.png', fullPage: false });
  await page.locator('.qc-image').nth(1).getByRole('button', { name: 'Переместить раньше' }).click();
  assert.equal(await page.locator('#qc-platform-preview').isVisible(), false,
    'changing local media order invalidates the previous approximate view');
  await page.locator('#qc-platform-preview-load').click();
  await page.locator('#qc-platform-preview-choice').selectOption(telegramLocalOption);
  const reorderedLocal = await page.locator('.qc-platform-media img').evaluateAll((images) =>
    images.map((img) => img.getAttribute('src')));
  assert.deepEqual(reorderedLocal, [...originalLocalOrder].reverse(),
    'local preview follows the operator-specified image order');
  page.off('request', recordPreviewGet);

  // D3a: while no draft exists, a distinct VK account gets its own caption.
  // The two Telegram targets must continue inheriting canonical base text.
  await page.locator('#qc-variant-editor summary').click();
  assert.equal(await page.locator('#qc-variant-choice option').count(), 3);
  await page.locator('#qc-variant-choice').selectOption(accounts[2].id);
  await page.locator('#qc-variant-text').fill('Вариант публикации только для VK');
  assert.match(await page.locator('#qc-variant-status').textContent(), /Отдельный текст подготовлен/);
  assert.equal(await page.locator('#qc-platform-preview').isVisible(), false);
  await page.locator('#qc-platform-preview-load').click();
  await page.locator('#qc-platform-preview-choice').selectOption(vkLocalOption);
  assert.match(await page.locator('.qc-platform-caption').textContent(), /Вариант публикации только для VK/);
  await page.locator('#qc-platform-preview-choice').selectOption(telegramLocalOption);
  assert.match(await page.locator('.qc-platform-caption').textContent(), /Наша новая публикация/);
  assert.doesNotMatch(await page.locator('.qc-platform-caption').textContent(), /только для VK/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0,
    'editing a target variant before Save has no server side effect');
  await page.screenshot({ path: 'test-results/p0-composer-per-account-text-variant.png', fullPage: false });
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
  assert.equal(db.prepare('SELECT override_text FROM post_targets WHERE post_id=? AND account_id=?')
    .get(post.id, accounts[2].id).override_text, 'Вариант публикации только для VK');
  assert.equal(db.prepare('SELECT override_text FROM post_targets WHERE post_id=? AND account_id=?')
    .get(post.id, accounts[0].id).override_text, null, 'Telegram still inherits canonical base');
  assert.equal(db.prepare('SELECT override_text FROM post_targets WHERE post_id=? AND account_id=?')
    .get(post.id, accounts[1].id).override_text, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, 1, 'no duplicate post');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM publication_events WHERE event_type LIKE '%publish%'").get().n, 0,
    'saving must not publish outside the application');

  // D1: canonical account-specific preview should be readable in the same
  // editor without reopening or sending anything to an external provider.
  assert.equal(await page.locator('#qc-platform-preview-load').isDisabled(), false,
    'read-only platform preview is offered after saving the actual server draft');
  await page.locator('#qc-platform-preview-load').click();
  await page.locator('#qc-platform-preview:not([hidden])').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#qc-platform-preview-choice option').count(), 3);
  assert.match(await page.locator('#qc-platform-preview-source').textContent(), /сохранённой серверной версии/);
  assert.ok((await page.locator('.qc-platform-media img').first().getAttribute('src')).startsWith('/public-media/'),
    'server preview after Save uses canonical media URLs rather than old local blobs');
  const desktopPreviewVisible = await page.evaluate(() => {
    const card = document.querySelector('#qc-platform-preview-card').getBoundingClientRect();
    const head = document.querySelector('.qc-head').getBoundingClientRect();
    const footer = document.querySelector('.qc-footer').getBoundingClientRect();
    return card.top < footer.top && card.bottom > head.bottom;
  });
  assert.equal(desktopPreviewVisible, true,
    'opening the server preview must reveal the result in the visible desktop scroll pane');
  const telegramTarget = db.prepare('SELECT id FROM post_targets WHERE post_id=? AND account_id=?')
    .get(post.id, accounts[0].id).id;
  const vkTarget = db.prepare('SELECT id FROM post_targets WHERE post_id=? AND account_id=?')
    .get(post.id, accounts[2].id).id;
  await page.locator('#qc-platform-preview-choice').selectOption(telegramTarget);
  assert.match(await page.locator('#qc-platform-preview-card').textContent(), /Telegram · Account 0/);
  assert.match(await page.locator('#qc-platform-preview-card').textContent(), /Наша новая публикация/);
  assert.equal(await page.locator('.qc-platform-media img').count(), 2);
  let parts = await page.locator('#qc-platform-preview-card > *').evaluateAll((elements) =>
    elements.map((item) => item.className));
  assert.ok(parts.indexOf('qc-platform-media') < parts.indexOf('qc-platform-caption'),
    'Telegram caption is displayed after canonical media order');
  await page.locator('#qc-platform-preview-choice').selectOption(vkTarget);
  assert.match(await page.locator('#qc-platform-preview-card').textContent(), /ВКонтакте · Account 2/);
  assert.match(await page.locator('.qc-platform-caption').textContent(), /Вариант публикации только для VK/,
    'server-compiled preview uses the saved VK target override');
  parts = await page.locator('#qc-platform-preview-card > *').evaluateAll((elements) =>
    elements.map((item) => item.className));
  assert.ok(parts.indexOf('qc-platform-caption') < parts.indexOf('qc-platform-media'),
    'VK caption is displayed before canonical images');
  assert.equal(await page.locator('.qc-platform-media img').count(), 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, 1,
    'opening account previews must not create new posts');
  await page.screenshot({ path: 'test-results/p0-composer-platform-preview-desktop.png', fullPage: false });

  // Explicit reset is a versioned PATCH(null), not a change to the base text.
  await page.locator('#qc-variant-choice').selectOption(accounts[2].id);
  await page.locator('#qc-variant-reset').click();
  assert.match(await page.locator('#qc-variant-status').textContent(), /наследование/);
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  assert.equal(db.prepare('SELECT override_text FROM post_targets WHERE post_id=? AND account_id=?')
    .get(post.id, accounts[2].id).override_text, null, 'reset returns VK to inherited text');
  assert.equal(db.prepare('SELECT body FROM posts WHERE id=?').get(post.id).body,
    'Наша новая публикация\n\nВторой абзац для нескольких площадок.',
    'changing recipient text never mutates canonical content');
  await page.locator('#qc-platform-preview-load').click();
  await page.locator('#qc-platform-preview-choice').selectOption(vkTarget);
  assert.match(await page.locator('.qc-platform-caption').textContent(), /Наша новая публикация/);
  await page.screenshot({ path: 'test-results/p0-composer-variant-inherited-again.png', fullPage: false });

  // Media order remains editable after the initial save and must reach the server.
  const initialOrder = db.prepare('SELECT id FROM media WHERE post_id=? ORDER BY sort_order,created_at').all(post.id)
    .map((row) => row.id);
  assert.equal(initialOrder.length, 2);
  await page.locator('.qc-image').nth(1).getByRole('button', { name: 'Переместить раньше' }).click();
  assert.equal(await page.locator('#qc-platform-preview').isVisible(), false,
    'changing media order invalidates previously loaded account-specific preview');
  assert.equal(await page.locator('#qc-platform-preview-load').isDisabled(), false);
  await page.locator('#qc-platform-preview-load').click();
  await page.locator('#qc-platform-preview:not([hidden])').waitFor({ timeout: 30000 });
  assert.match(await page.locator('#qc-platform-preview-source').textContent(), /Несохранённые изменения/);
  assert.ok((await page.locator('.qc-platform-media img').first().getAttribute('src')).startsWith('blob:'),
    'edited saved draft shows local media until the new version is committed');
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

  // Uploading identical normalized image bytes under different names must not
  // create duplicate cards, invalid media orders or broken delete actions.
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Проверка одинаковых фотографий');
  await page.locator('#qc-files').setInputFiles([
    { name: 'original.png', mimeType: 'image/png', buffer: image1 },
    { name: 'renamed-copy.png', mimeType: 'image/png', buffer: image1 }
  ]);
  assert.equal(await page.locator('.qc-image').count(), 2);
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: /Одинаковые изображения объединены: 1/ })
    .waitFor({ timeout: 30000 });
  const dedupPostId = db.prepare('SELECT id FROM posts ORDER BY rowid DESC LIMIT 1').get().id;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(dedupPostId).n, 1);
  assert.equal(await page.locator('.qc-image').count(), 1,
    'a deduplicated server media ID must have only one editable card');
  await page.locator('.qc-image button[aria-label^="Удалить"]').click();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(dedupPostId).n, 0,
    'removing the remaining unique image must delete exactly one persisted media');
  await closeComposer();

  // Disabled accounts must remain disabled after a save toggles the entire editor busy.
  db.prepare('UPDATE social_accounts SET enabled=0 WHERE id=?').run(accounts[10].id);
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Недоступные аккаунты не участвуют в отправке');
  const unavailable = page.locator('input[name="qc-account"][value="' + accounts[10].id + '"]');
  assert.equal(await unavailable.isDisabled(), true);
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  assert.equal(await unavailable.isDisabled(), true, 'unavailable checkbox remains disabled after setBusy(false)');
  await page.locator('#qc-select-all').click();
  assert.equal(await unavailable.isChecked(), false, 'select all excludes disabled account');
  assert.match(await page.locator('#qc-counter').textContent(), /10 выбрано/);
  await closeComposer();

  // When zero accounts are available, navigating away from text + image draft
  // requires confirmation and can be cancelled without losing the composer.
  db.prepare('UPDATE social_accounts SET enabled=0').run();
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Не терять черновик при переходе к соцсетям');
  await page.locator('#qc-files').setInputFiles([
    { name: 'not-saved.png', mimeType: 'image/png', buffer: image2 }
  ]);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#qc-connect').click();
  assert.equal(await page.locator('#qc-text').inputValue(), 'Не терять черновик при переходе к соцсетям');
  assert.equal(await page.locator('.qc-image').count(), 1);
  await closeComposer();
  db.prepare('UPDATE social_accounts SET enabled=1').run();

  // B2A: a tab refresh must restore text, accounts and schedule without
  // creating a server post. File bytes are deliberately not stored in sessionStorage.
  const countBeforeRecovery = db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Черновик на телефоне до перезагрузки');
  await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').check();
  await page.locator('#qc-variant-editor summary').click();
  await page.locator('#qc-variant-text').fill('Личный вариант перед перезагрузкой');
  await page.locator('.qc-advanced summary').click();
  await page.locator('#qc-project').selectOption(projectId);
  await page.locator('#qc-datetime').fill('2026-11-16T18:30');
  await page.locator('#qc-files').setInputFiles([
    { name: 'offline-file.png', mimeType: 'image/png', buffer: image2 }
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, countBeforeRecovery,
    'local recovery must never implicitly create a server draft');
  db.prepare("UPDATE projects SET default_timezone='UTC' WHERE id=?").run(projectId);
  await page.reload();
  await page.locator('#app:not(.hidden)').waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').waitFor();
  assert.equal(await page.locator('#qc-text').inputValue(), 'Черновик на телефоне до перезагрузки');
  assert.equal(await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').isChecked(), true);
  await page.locator('#qc-variant-editor summary').click();
  assert.equal(await page.locator('#qc-variant-text').inputValue(),
    'Личный вариант перед перезагрузкой',
    'tab-local recovery preserves per-account variant text only for selected accounts');
  await page.locator('.qc-advanced summary').click();
  assert.equal(await page.locator('#qc-datetime').inputValue(), '2026-11-16T18:30');
  assert.match(await page.locator('#qc-timezone-note').textContent(), /Europe\/Moscow/,
    'recovering wall-clock time must keep its original IANA zone if the project default changes');
  assert.equal(await page.locator('.qc-image').count(), 0,
    'never pretend an unsaved photo survived a refresh');
  assert.match(await page.locator('#qc-status').textContent(), /Добавьте фотографии заново/);
  assert.equal(await page.locator('#qc-missing-media').isVisible(), true);
  await page.locator('#qc-text').fill('Черновик на телефоне до перезагрузки — исправлен');
  // A second interruption after editing text must not silently remove the
  // outstanding photo requirement or rewrite the original timezone.
  await page.reload();
  await page.locator('#app:not(.hidden)').waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').waitFor();
  assert.equal(await page.locator('#qc-text').inputValue(),
    'Черновик на телефоне до перезагрузки — исправлен');
  assert.equal(await page.locator('#qc-missing-media').isVisible(), true,
    'second reload must retain missing-photo warning after text edits');
  assert.match(await page.locator('#qc-missing-media-detail').textContent(), /1 фото/);
  assert.match(await page.locator('#qc-timezone-note').textContent(), /Europe\/Moscow/);
  await page.screenshot({ path: 'test-results/p0-composer-recovery-warning.png', fullPage: false });
  await page.locator('#qc-save').click();
  assert.match(await page.locator('#qc-status').textContent(), /Снова приложите фотографии/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, countBeforeRecovery,
    'recovered missing photos cannot be silently omitted from a save');
  await page.locator('#qc-files').setInputFiles([
    { name: 'restored-photo.png', mimeType: 'image/png', buffer: image2 }
  ]);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#qc-schedule').click();
  await page.locator('#qc-status').filter({ hasText: /Публикация запланирована|Черновик сохранён:/ })
    .waitFor({ timeout: 30000 });
  const restoredSchedule = db.prepare(
    'SELECT id,schedule_mode,schedule_timezone,scheduled_at_utc FROM posts WHERE project_id=? AND title=?'
  ).get(projectId, 'Черновик на телефоне до перезагрузки — исправлен');
  assert.ok(restoredSchedule?.id, 'restored content must create one server draft after explicit save');
  assert.equal(restoredSchedule.schedule_mode, 'AT');
  assert.equal(restoredSchedule.schedule_timezone, 'Europe/Moscow',
    'recovering schedule must preserve original timezone even after project defaults change');
  assert.equal(restoredSchedule.scheduled_at_utc, '2026-11-16T15:30:00.000Z',
    'restored local time must retain its original absolute UTC instant');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, countBeforeRecovery + 1,
    'single operation after restored media cannot create a duplicate server draft');
  db.prepare("UPDATE projects SET default_timezone='Europe/Moscow' WHERE id=?").run(projectId);
  await closeComposer();
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').waitFor();
  assert.equal(await page.locator('#qc-text').inputValue(), '',
    'confirmed server save must clear tab recovery data');
  await closeComposer();

  // B2a: two recovered byte-identical photos count as two missing local files
  // before save, but as one persisted server media ID after deduplication.
  const dedupBefore = db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Восстановление одинаковых фотографий');
  await page.locator('#qc-files').setInputFiles([
    { name: 'lost-a.png', mimeType: 'image/png', buffer: image1 },
    { name: 'lost-b.png', mimeType: 'image/png', buffer: image1 }
  ]);
  await page.reload();
  await page.locator('#app:not(.hidden)').waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').waitFor();
  assert.match(await page.locator('#qc-missing-media-detail').textContent(), /2 фото/,
    'both missing files must be acknowledged before a first save');
  await page.locator('#qc-files').setInputFiles([
    { name: 'returned-a.png', mimeType: 'image/png', buffer: image1 },
    { name: 'returned-b.png', mimeType: 'image/png', buffer: image1 }
  ]);
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  const dedupRecoveredPost = db.prepare('SELECT id FROM posts ORDER BY rowid DESC LIMIT 1').get().id;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, dedupBefore + 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(dedupRecoveredPost).n, 1);
  assert.equal(await page.locator('.qc-image').count(), 1);
  assert.equal(await page.locator('#qc-missing-media').isVisible(), false,
    'successful persistence retires original missing-media guard');
  await page.locator('.qc-image button[aria-label^="Удалить"]').click();
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(dedupRecoveredPost).n, 0,
    'deliberate deletion after successful recovery must not be blocked by stale requirement');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, dedupBefore + 1);
  await closeComposer();

  // A later HTTP 503 after two normalized-equal uploads must not lock out retry.
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Восстановленный набор из трёх фотографий');
  await page.locator('#qc-files').setInputFiles([
    { name: 'original-1.png', mimeType: 'image/png', buffer: image1 },
    { name: 'original-1-copy.png', mimeType: 'image/png', buffer: image1 },
    { name: 'original-2.png', mimeType: 'image/png', buffer: image2 }
  ]);
  await page.reload();
  await page.locator('#app:not(.hidden)').waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').waitFor();
  assert.match(await page.locator('#qc-missing-media-detail').textContent(), /3 фото/);
  await page.locator('#qc-files').setInputFiles([
    { name: 'retry-1.png', mimeType: 'image/png', buffer: image1 },
    { name: 'retry-1-copy.png', mimeType: 'image/png', buffer: image1 },
    { name: 'retry-2.png', mimeType: 'image/png', buffer: image2 }
  ]);
  let uploadsSeen = 0;
  await page.route('**/api/posts/*/media', async (route) => {
    if (route.request().method() === 'POST' && ++uploadsSeen === 3) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.continue();
  });
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: /HTTP 503/ }).waitFor({ timeout: 30000 });
  const interruptedMediaPost = db.prepare('SELECT id FROM posts ORDER BY rowid DESC LIMIT 1').get().id;
  assert.equal(uploadsSeen, 3);
  assert.equal(await page.locator('.qc-image').count(), 2,
    'server dedup removes duplicate local card even if a later upload fails');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(interruptedMediaPost).n, 1);
  await page.unroute('**/api/posts/*/media');
  let failMediaOrderOnce = true;
  await page.route('**/api/posts/*/media-order', async (route) => {
    if (failMediaOrderOnce && route.request().method() === 'PUT') {
      failMediaOrderOnce = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.continue();
  });
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: /HTTP 503/ }).waitFor({ timeout: 30000 });
  assert.equal(failMediaOrderOnce, false,
    'force the media-order failure after deduplicated images have already reached the server');
  assert.equal(await page.locator('.qc-image').count(), 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(interruptedMediaPost).n, 2);
  await page.unroute('**/api/posts/*/media-order');
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(interruptedMediaPost).n, 2,
    'retry after media-order failure must use the original draft and must not duplicate images');
  await closeComposer();

  // P1: once a server POST starts, session recovery must become uncertain
  // before any server response. Never keep a misleading local-only snapshot.
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Проверка маркера до POST');
  await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').check();
  let intercepted;
  const reached = new Promise((resolve) => { intercepted = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/posts', async (route) => {
    if (route.request().method() === 'POST') {
      intercepted();
      await gate;
    }
    await route.continue();
  });
  await page.locator('#qc-save').click();
  await reached;
  const inFlight = await page.evaluate(() => {
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith('publikator.quick-composer.recovery.v1')) continue;
      try { const value = JSON.parse(sessionStorage.getItem(key)); if (value.kind === 'uncertain') return value; }
      catch { /* not recovery */ }
    }
    return null;
  });
  assert.equal(inFlight?.kind, 'uncertain', 'uncertain marker precedes the external POST outcome');
  release();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  await page.unroute('**/api/posts');
  await closeComposer();

  // An interrupted create cannot be cleared by one accidental click: the
  // operator must explicitly confirm reconciliation with the publications list.
  assert.equal(await page.evaluate(async () => {
    const auth = await (await fetch('/api/auth/state')).json();
    const { createComposerRecovery } = await import('/quick-composer-recovery-v1.js');
    return createComposerRecovery(auth).saveUncertain();
  }), true, 'simulate recovered unknown create result without contacting providers');
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-recovery-warning.is-visible').waitFor();
  assert.equal(await page.locator('#qc-save').isDisabled(), true);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#qc-start-new').click();
  assert.equal(await page.locator('#qc-recovery-warning').isVisible(), true,
    'dismissed reconciliation must keep unknown-outcome guard');
  assert.equal(await page.locator('#qc-save').isDisabled(), true);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#qc-start-new').click();
  assert.equal(await page.locator('#qc-recovery-warning').isVisible(), false);
  assert.equal(await page.locator('#qc-save').isDisabled(), false);
  await closeComposer();

  // P2: the 24h expiration applies to unsaved local text, never to an
  // ambiguous server operation that still requires explicit reconciliation.
  const guardTtl = await page.evaluate(async () => {
    const auth = await (await fetch('/api/auth/state')).json();
    const { createComposerRecovery } = await import('/quick-composer-recovery-v1.js');
    const recovery = createComposerRecovery(auth);
    const expire = () => {
      const key = Object.keys(sessionStorage).find((item) =>
        item.startsWith('publikator.quick-composer.recovery.v1'));
      const entry = JSON.parse(sessionStorage.getItem(key));
      sessionStorage.setItem(key, JSON.stringify({
        ...entry, updatedAt: Date.now() - 26 * 60 * 60 * 1000
      }));
    };
    recovery.saveUncertain();
    expire();
    const uncertain = recovery.read()?.kind;
    recovery.saveServerDraft('post_known_by_id');
    expire();
    const serverDraft = recovery.read()?.kind;
    recovery.saveLocalDraft({ body: 'Истекший локальный текст', accountIds: [] });
    expire();
    const local = recovery.read();
    recovery.clear();
    return { uncertain, serverDraft, local };
  });
  assert.deepEqual(guardTtl, { uncertain: 'uncertain', serverDraft: 'server-draft', local: null },
    'local text may expire, but ambiguous or known server-draft markers must survive TTL');

  // P1: Save draft clears old recovery record. A subsequent Publish Now in the
  // SAME editor must restore the durable marker before the outbound request.
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Сначала сохранить, затем опубликовать без дубликата');
  await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').check();
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  let publishReached;
  const publishStarted = new Promise((resolve) => { publishReached = resolve; });
  let releasePublish;
  const heldPublish = new Promise((resolve) => { releasePublish = resolve; });
  await page.route('**/api/posts/*/publish-now', async (route) => {
    publishReached();
    await heldPublish;
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ post: { status: 'PUBLISHED' } })
    });
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#qc-send').click();
  await publishStarted;
  const publishMarker = await page.evaluate(() => {
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith('publikator.quick-composer.recovery.v1')) continue;
      try { return JSON.parse(sessionStorage.getItem(key)); }
      catch { /* ignore malformed test data */ }
    }
    return null;
  });
  assert.equal(publishMarker?.kind, 'server-draft',
    'published from an existing saved draft must persist a server-draft marker before POST');
  assert.ok(publishMarker?.savedId?.startsWith('post_'),
    'recovery marker must contain the exact saved draft identifier');
  releasePublish();
  await page.locator('#qc-status').filter({ hasText: 'Публикация обработана' }).waitFor({ timeout: 30000 });
  await page.unroute('**/api/posts/*/publish-now');
  await closeComposer();

  // C1: an actual H.264 MP4 must be selectable and previewable before a
  // server draft exists. The server generates its own poster media.
  const mp4Path = path.join(dir, 'c1-user-picked.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=15:d=1',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-y', mp4Path
  ], { timeout: 25000 });
  const mp4 = await fs.readFile(mp4Path);
  assert.ok(mp4.length > 1024, 'FFmpeg must produce real H.264 MP4 fixture');
  const beforeC1 = db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Короткое видео для школьного проекта');

  await page.locator('#qc-video-file').setInputFiles([
    { name: 'unsupported.webm', mimeType: 'video/webm', buffer: mp4 }
  ]);
  assert.match(await page.locator('#qc-status').textContent(), /video\/mp4|MP4/);
  assert.equal(await page.locator('#qc-video-preview video').count(), 0,
    'WebM is rejected before any server side effect');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeC1);

  await page.locator('#qc-video-file').setInputFiles([
    { name: 'lesson-clip.mp4', mimeType: 'video/mp4', buffer: mp4 }
  ]);
  assert.equal(await page.locator('#qc-video-preview video').count(), 1);
  assert.match(await page.locator('#qc-video-preview').textContent(), /lesson-clip\.mp4/);
  assert.match(await page.locator('#qc-video-preview').textContent(), /(?:КБ|МБ)/,
    'file size must be displayed accurately in KB or MB');
  assert.equal(await page.locator('#qc-files').isDisabled(), true,
    'image picker must block mixing photos with MP4');
  await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').check();
  await page.locator('#qc-platform-preview-load').click();
  await page.locator('#qc-platform-preview:not([hidden])').waitFor({ timeout: 30000 });
  assert.match(await page.locator('#qc-platform-preview-source').textContent(), /До сохранения/);
  assert.equal(await page.locator('.qc-platform-media video').count(), 1,
    'operator-selected unsaved MP4 appears in local platform preview');
  assert.ok((await page.locator('.qc-platform-media video').getAttribute('src')).startsWith('blob:'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeC1,
    'previewing MP4 without saving must not create a draft');
  await page.screenshot({ path: 'test-results/p0-composer-video-desktop.png', fullPage: false });
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 45000 });
  const videoPost = db.prepare('SELECT id,status,content_format FROM posts ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(videoPost.status, 'DRAFT');
  assert.equal(videoPost.content_format, 'VIDEO');
  const persistedMedia = db.prepare('SELECT id,mime_type FROM media WHERE post_id=?').all(videoPost.id);
  assert.equal(persistedMedia.filter((m) => m.mime_type === 'video/mp4').length, 1);
  assert.equal(persistedMedia.filter((m) => m.mime_type === 'image/jpeg').length, 1,
    'server poster must be a generated asset, not a second user image');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeC1 + 1);
  assert.equal(await page.locator('#qc-video-preview video').count(), 1);
  assert.match(await page.locator('#qc-video-preview').textContent(), /загружено на сервер/);
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(videoPost.id).n, 2,
    'saving MP4 again must not produce a second video or poster');

  // A versioned video deletion removes its generated poster as well.
  await page.locator('#qc-video-preview button[aria-label^="Удалить видео"]').click();
  await page.locator('#qc-video-preview video').waitFor({ state: 'detached', timeout: 30000 });
  const remainingAfterVideoDelete = db.prepare('SELECT id,mime_type,poster_asset_id FROM media WHERE post_id=?')
    .all(videoPost.id);
  assert.deepEqual(remainingAfterVideoDelete, [],
    'deleting saved MP4 must remove both video and generated poster (remaining: ' +
    JSON.stringify(remainingAfterVideoDelete) + ')');
  assert.equal(await page.locator('#qc-files').isDisabled(), false);
  await page.locator('#qc-files').setInputFiles([
    { name: 'now-a-photo.png', mimeType: 'image/png', buffer: image2 }
  ]);
  assert.equal(await page.locator('#qc-video-file').isDisabled(), true,
    'video picker must block the reverse mixed-media selection');
  await closeComposer();

  // C1: MP4 bytes cannot survive reload. Recovery must prevent a silent
  // text-only post until the operator reattaches or explicitly waives it.
  const beforeMp4Restore = db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Восстановление видео после обновления');
  await page.locator('#qc-video-file').setInputFiles([
    { name: 'interrupted.mp4', mimeType: 'video/mp4', buffer: mp4 }
  ]);
  await page.reload();
  await page.locator('#app:not(.hidden)').waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').waitFor();
  assert.equal(await page.locator('#qc-text').inputValue(), 'Восстановление видео после обновления');
  assert.equal(await page.locator('#qc-missing-video').isVisible(), true);
  assert.equal(await page.locator('#qc-video-preview video').count(), 0);
  assert.equal(await page.locator('#qc-video-file').isDisabled(), false);
  assert.equal(await page.locator('#qc-files').isDisabled(), true);
  await page.locator('#qc-save').click();
  assert.match(await page.locator('#qc-status').textContent(), /Снова выберите MP4/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeMp4Restore);
  await page.locator('#qc-video-file').setInputFiles([
    { name: 'reselected.mp4', mimeType: 'video/mp4', buffer: mp4 }
  ]);
  assert.equal(await page.locator('#qc-missing-video').isVisible(), false);
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 45000 });
  const recoveredVideoPost = db.prepare('SELECT id,content_format FROM posts ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(recoveredVideoPost.content_format, 'VIDEO');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(recoveredVideoPost.id).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeMp4Restore + 1,
    'reselect and save must create exactly one draft');
  await closeComposer();

  // C1/P2: a definitive create validation failure cannot rewrite the
  // recovery record as text-only and silently forget the selected MP4.
  const beforeRejectedVideo = db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Проверка восстановления MP4 после отказа сервера');
  await page.locator('#qc-video-file').setInputFiles([
    { name: 'retry-after-reject.mp4', mimeType: 'video/mp4', buffer: mp4 }
  ]);
  await page.route('**/api/posts', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ error: 'Неверное расписание' }) });
    } else {
      await route.continue();
    }
  });
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: /Неверное расписание/ }).waitFor({ timeout: 30000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeRejectedVideo);
  await page.unroute('**/api/posts');
  await page.reload();
  await page.locator('#app:not(.hidden)').waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').waitFor();
  assert.equal(await page.locator('#qc-text').inputValue(),
    'Проверка восстановления MP4 после отказа сервера');
  assert.equal(await page.locator('#qc-missing-video').isVisible(), true,
    'definitive 4xx must retain video-required across refresh');
  await page.locator('#qc-save').click();
  assert.match(await page.locator('#qc-status').textContent(), /Снова выберите MP4/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeRejectedVideo);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#qc-skip-recovered-video').click();
  assert.equal(await page.locator('#qc-missing-video').isVisible(), false,
    'operator can explicitly waive a missing MP4, not implicitly lose it');
  await closeComposer();

  // C2a: browser clipboard image paste must use the normal versioned media
  // queue before AND after the first Save, without creating another post.
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Фотографии вставлены из буфера обмена');
  const textPastePrevented = await page.evaluate(() => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', 'Обычный текст');
    const event = new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: clipboard
    });
    document.querySelector('#qc-text').dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(textPastePrevented, false,
    'text-only clipboard paste remains native; do not hijack normal text editing');
  async function pasteImage(buffer, filename) {
    return page.evaluate(({ bytes, name }) => {
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
      const event = new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: clipboard
      });
      document.querySelector('#qc-text').dispatchEvent(event);
      return event.defaultPrevented;
    }, { bytes: Array.from(buffer), name: filename });
  }
  assert.equal(await pasteImage(image1, 'clipboard-one.png'), true,
    'image clipboard paste must be consumed inside the composer');
  assert.equal(await page.locator('.qc-image').count(), 1);
  assert.match(await page.locator('#qc-status').textContent(), /из буфера обмена/i);
  await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').check();
  const beforeClipboardPost = db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#qc-close').textContent(), '×',
    'close control must retain a compact icon after draft save');
  assert.equal(await page.locator('#qc-close').getAttribute('aria-label'), 'Закрыть редактор');
  const clipboardPostId = db.prepare('SELECT id FROM posts ORDER BY rowid DESC LIMIT 1').get().id;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeClipboardPost + 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(clipboardPostId).n, 1);
  assert.equal(await pasteImage(image2, 'clipboard-two.png'), true,
    'clipboard paste remains available after server draft save');
  assert.equal(await page.locator('.qc-image').count(), 2);
  await page.screenshot({ path: 'test-results/p0-composer-clipboard-paste.png', fullPage: false });
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeClipboardPost + 1,
    'pasting extra images into a saved draft must not create duplicate posts');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(clipboardPostId).n, 2);
  const clipboardOrder = db.prepare('SELECT id FROM media WHERE post_id=? ORDER BY sort_order,created_at')
    .all(clipboardPostId).map((row) => row.id);
  assert.equal(new Set(clipboardOrder).size, 2, 'clipboard attachments have two unique persisted IDs');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM publication_events WHERE post_id=? AND event_type LIKE ?')
    .get(clipboardPostId, '%publish%').n, 0, 'clipboard paste and Save never publish externally');
  await closeComposer();

  // Pasting an image must not bypass the no-mixed-photo/video safety rule.
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Видеопубликация без смешанных вложений');
  await page.locator('#qc-video-file').setInputFiles([
    { name: 'only-video.mp4', mimeType: 'video/mp4', buffer: mp4 }
  ]);
  assert.equal(await pasteImage(image1, 'blocked-clipboard.png'), true);
  assert.equal(await page.locator('.qc-image').count(), 0);
  assert.match(await page.locator('#qc-status').textContent(), /Смешивание фото и видео/);
  assert.equal(await page.locator('#qc-video-preview video').count(), 1);
  await closeComposer();

  // C2b: empty text without any media remains invalid; caption-free images
  // use the existing versioned image and target APIs, not another publisher.
  const beforeMediaOnly = db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-save').click();
  assert.match(await page.locator('#qc-status').textContent(), /Добавьте текст, фотографии или MP4/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeMediaOnly);
  await page.locator('#qc-files').setInputFiles([
    { name: 'only-picture.png', mimeType: 'image/png', buffer: image1 }
  ]);
  assert.equal(await page.locator('#qc-preview-text').textContent(), 'Без подписи');
  await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').check();
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  const mediaOnly = db.prepare('SELECT * FROM posts ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeMediaOnly + 1);
  assert.equal(mediaOnly.title, 'Публикация', 'captionless media requires only an internal title');
  assert.equal(mediaOnly.body, '', 'an empty caption must never be replaced by an unwanted title');
  assert.equal(mediaOnly.content_format, 'IMAGE');
  assert.equal(mediaOnly.status, 'DRAFT');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(mediaOnly.id).n, 1);
  assert.deepEqual(db.prepare('SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1')
    .all(mediaOnly.id).map((row) => row.account_id), [accounts[0].id]);
  await page.locator('#qc-files').setInputFiles([
    { name: 'other-picture.png', mimeType: 'image/png', buffer: image2 }
  ]);
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 30000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeMediaOnly + 1);
  const mediaOnlyCarousel = db.prepare('SELECT body,content_format,content_version FROM posts WHERE id=?')
    .get(mediaOnly.id);
  assert.equal(mediaOnlyCarousel.body, '');
  assert.equal(mediaOnlyCarousel.content_format, 'CAROUSEL');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(mediaOnly.id).n, 2);
  await page.screenshot({ path: 'test-results/p0-composer-media-only-images.png', fullPage: false });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM publication_events WHERE post_id=? AND event_type LIKE ?')
    .get(mediaOnly.id, '%publish%').n, 0, 'captionless draft must never call a social provider');
  await closeComposer();

  // A disabled selected destination must not become READY just because a
  // caption-free carousel has actual media. Existing preflight remains authoritative.
  db.prepare('UPDATE social_accounts SET enabled=0 WHERE id=?').run(accounts[0].id);
  const deniedPreflight = await page.evaluate(async ({ postId, expectedContentVersion }) => {
    const response = await fetch('/api/posts/' + encodeURIComponent(postId) + '/ready', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedContentVersion })
    });
    return { status: response.status, body: await response.json() };
  }, { postId: mediaOnly.id, expectedContentVersion: mediaOnlyCarousel.content_version });
  assert.equal(deniedPreflight.status, 409, 'disabled recipient must be blocked by server READY');
  assert.match(String(deniedPreflight.body.error), /отключён|аккаунт|сеть|готов/i);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(mediaOnly.id).status, 'DRAFT');
  db.prepare('UPDATE social_accounts SET enabled=1 WHERE id=?').run(accounts[0].id);

  // Existing REST text-only contract must not be weakened by media-only mode.
  const projectForValidation = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
  const noTextOnlyPost = await page.evaluate(async (projectId) => {
    const response = await fetch('/api/posts', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId, title: 'Text-only without text is invalid', body: '',
        bodyRich: { type: 'doc', content: [] },
        contentFormat: 'TEXT_ONLY', scheduleMode: 'MANUAL'
      })
    });
    return { status: response.status, body: await response.json() };
  }, projectForValidation);
  assert.equal(noTextOnlyPost.status, 400, 'TEXT_ONLY with empty text must remain invalid');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeMediaOnly + 1);

  // C2b: video-only is also a media draft; the server retains VIDEO and the
  // generated poster without inventing any caption or triggering provider POST.
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-video-file').setInputFiles([
    { name: 'no-caption.mp4', mimeType: 'video/mp4', buffer: mp4 }
  ]);
  await page.locator('input[name="qc-account"][value="' + accounts[1].id + '"]').check();
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 45000 });
  const videoOnly = db.prepare('SELECT * FROM posts ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(videoOnly.body, '');
  assert.equal(videoOnly.title, 'Публикация');
  assert.equal(videoOnly.content_format, 'VIDEO');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=? AND mime_type=?')
    .get(videoOnly.id, 'video/mp4').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE post_id=?').get(videoOnly.id).n, 2,
    'single captionless MP4 still has a generated poster');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, beforeMediaOnly + 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM publication_events WHERE post_id=? AND event_type LIKE ?')
    .get(videoOnly.id, '%publish%').n, 0);
  await page.screenshot({ path: 'test-results/p0-composer-media-only-video.png', fullPage: false });
  await closeComposer();

  // C2c: the READY endpoint reports authoritative per-target preflight
  // diagnostics. Show exactly which account failed without issuing publish-now,
  // and render server-provided text safely (never as HTML).
  const beforePerAccountCheck = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Проверить доступность двух подключений');
  for (const account of [accounts[0], accounts[2]]) {
    await page.locator('input[name="qc-account"][value="' + account.id + '"]').check();
  }
  await page.locator('.qc-advanced summary').click();
  await page.locator('#qc-datetime').fill('2027-02-14T14:30');
  const readyIssues = [
    {
      accountId: accounts[0].id, accountName: 'Account 0',
      platform: 'telegram', severity: 'error',
      message: 'Нет права публикации в канал. Проверьте настройки бота.'
    },
    {
      accountId: accounts[2].id, accountName: 'Account 2',
      platform: 'vk', severity: 'error',
      message: 'Нет доступа к стене <b>сообщества</b>. Проверьте токен.'
    }
  ];
  let readinessChecks = 0;
  let unexpectedPublishNow = 0;
  const onComposerRequest = (request) => {
    if (request.url().includes('/publish-now')) unexpectedPublishNow += 1;
  };
  page.on('request', onComposerRequest);
  await page.route('**/api/posts/*/ready', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    readinessChecks += 1;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Пост не готов к публикации', issues: readyIssues })
    });
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#qc-schedule').click();
  await page.locator('#qc-preflight-issues:not([hidden])').waitFor({ timeout: 30000 });
  assert.equal(readinessChecks, 1, 'READY is evaluated once before any scheduled publication');
  assert.equal(unexpectedPublishNow, 0, 'failed preflight must never dispatch publish-now');
  const visibleFailures = await page.locator('#qc-preflight-issues').textContent();
  assert.match(visibleFailures, /Telegram · Account 0/);
  assert.match(visibleFailures, /VK|ВКонтакте/);
  assert.match(visibleFailures, /Account 2/);
  assert.match(visibleFailures, /Нет права публикации в канал/);
  assert.match(visibleFailures, /Нет доступа к стене <b>сообщества<\/b>/);
  assert.equal(await page.locator('#qc-preflight-issues li').count(), 2);
  assert.equal(await page.locator('#qc-preflight-issues b').count(), 0,
    'preflight diagnostic text must not be interpreted as markup');
  assert.match(await page.locator('#qc-status').textContent(), /Проверка готовности не пройдена/);
  const failedReadyPost = db.prepare('SELECT id,status FROM posts ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, beforePerAccountCheck + 1);
  assert.equal(failedReadyPost.status, 'DRAFT', 'preflight rejection keeps the draft editable');
  assert.deepEqual(
    db.prepare('SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1 ORDER BY account_id')
      .all(failedReadyPost.id).map((row) => row.account_id),
    [accounts[0].id, accounts[2].id].sort()
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM publication_events WHERE post_id=? AND event_type LIKE '%publish%'")
    .get(failedReadyPost.id).n, 0);
  await page.screenshot({ path: 'test-results/p0-composer-per-account-ready-errors.png', fullPage: false });
  await page.locator('#qc-text').fill('Поправка после отказа конкретного аккаунта');
  assert.equal(await page.locator('#qc-preflight-issues').isVisible(), false,
    'editing after failed readiness must discard stale per-target warnings');
  await page.unroute('**/api/posts/*/ready');
  page.off('request', onComposerRequest);
  await closeComposer();

  // D3a/P2: a definitive create failure (400) must retain the per-account
  // caption in same-tab recovery across a full browser reload.
  const countBeforeRejectedVariant = db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').fill('Отдельный вариант после отклонённого создания');
  await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').check();
  await page.locator('#qc-variant-editor summary').click();
  await page.locator('#qc-variant-text').fill('Текст выбранного Telegram после HTTP400');
  await page.route('**/api/posts', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 400, contentType: 'application/json',
        body: JSON.stringify({ error: 'Неверные параметры создания' })
      });
    } else await route.continue();
  });
  await page.locator('#qc-save').click();
  await page.locator('#qc-status').filter({ hasText: /Неверные параметры создания/ })
    .waitFor({ timeout: 30000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, countBeforeRejectedVariant);
  await page.unroute('**/api/posts');
  await page.reload();
  await page.locator('#app:not(.hidden)').waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#quick-compose-nav').click();
  await page.locator('#qc-text').waitFor();
  assert.equal(await page.locator('#qc-text').inputValue(),
    'Отдельный вариант после отклонённого создания');
  assert.equal(await page.locator('input[name="qc-account"][value="' + accounts[0].id + '"]').isChecked(), true);
  await page.locator('#qc-variant-editor summary').click();
  assert.equal(await page.locator('#qc-variant-text').inputValue(),
    'Текст выбранного Telegram после HTTP400',
    'rejected draft creation must not discard recoverable target-specific text');
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
  assert.equal(await mp.locator('#qc-target-toggle').isVisible(), true,
    'mobile offers a compact recipient chooser');
  assert.equal(await mp.locator('#qc-target-picker').isVisible(), false,
    '11 checkboxes must not inflate the main mobile composer');
  await mp.locator('#qc-target-toggle').click();
  assert.equal(await mp.locator('#qc-target-picker').isVisible(), true);
  assert.equal(await mp.locator('#qc-target-picker').getAttribute('aria-modal'), 'true');
  assert.equal(await mp.locator('input[name="qc-account"]').count(), 11);
  await mp.locator('input[name="qc-account"]').nth(0).check();
  await mp.locator('input[name="qc-account"]').nth(2).check();
  await mp.screenshot({ path: 'test-results/p0-composer-mobile-targets.png', fullPage: false });
  await mp.locator('#qc-target-done').click();
  assert.equal(await mp.locator('#qc-target-picker').isVisible(), false);
  assert.equal(await mp.locator('#qc-target-toggle').getAttribute('aria-expanded'), 'false');
  assert.match(await mp.locator('#qc-counter').textContent(), /2 выбрано/);
  assert.equal(await mp.locator('#qc-text').inputValue(), 'Новая публикация для всех подключений.');
  await mp.locator('#qc-platform-preview-load').click();
  await mp.locator('#qc-platform-preview:not([hidden])').waitFor({ timeout: 30000 });
  assert.equal(await mp.locator('#qc-platform-preview-choice option').count(), 2);
  assert.equal(await mp.locator('.qc-platform-media img').count(), 1);
  assert.match(await mp.locator('#qc-platform-preview-source').textContent(), /До сохранения/);
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    '390px local image preview must not cause horizontal overflow');
  await mp.screenshot({ path: 'test-results/p0-composer-local-preview-mobile.png', fullPage: false });
  await mp.locator('.qc-image button[aria-label^="Удалить"]').click();
  assert.equal(await mp.locator('#qc-video-file').isDisabled(), false);
  await mp.locator('#qc-video-file').setInputFiles([
    { name: 'mobile-video.mp4', mimeType: 'video/mp4', buffer: mp4 }
  ]);
  await mp.locator('#qc-video-preview video').scrollIntoViewIfNeeded();
  await mp.screenshot({ path: 'test-results/p0-composer-video-mobile.png', fullPage: false });
  assert.equal(await mp.locator('#qc-video-preview video').count(), 1);
  await mp.locator('#qc-platform-preview-load').click();
  await mp.locator('#qc-platform-preview:not([hidden])').waitFor({ timeout: 30000 });
  assert.equal(await mp.locator('.qc-platform-media video').count(), 1);
  assert.match(await mp.locator('#qc-platform-preview-source').textContent(), /До сохранения/);
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    '390px local MP4 preview must not overflow');
  await mp.locator('#qc-save').click();
  await mp.locator('#qc-status').filter({ hasText: 'Черновик сохранён' }).waitFor({ timeout: 45000 });
  await mp.locator('#qc-platform-preview-load').click();
  await mp.locator('#qc-platform-preview:not([hidden])').waitFor({ timeout: 30000 });
  assert.equal(await mp.locator('#qc-platform-preview-choice option').count(), 2);
  const mobilePreviewVisible = await mp.evaluate(() => {
    const card = document.querySelector('#qc-platform-preview-card').getBoundingClientRect();
    const head = document.querySelector('.qc-head').getBoundingClientRect();
    const footer = document.querySelector('.qc-footer').getBoundingClientRect();
    return card.top < footer.top && card.bottom > head.bottom;
  });
  assert.equal(mobilePreviewVisible, true,
    'opening the server preview must reveal content above the mobile sticky footer');
  assert.equal(await mp.locator('.qc-platform-media video').count(), 1,
    'mobile platform preview uses the actual saved MP4 rather than an invented thumbnail');
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    '390px per-account video preview must not introduce horizontal overflow');
  await mp.screenshot({ path: 'test-results/p0-composer-platform-preview-mobile.png', fullPage: false });

  // Mobile C2c: even with the video composer open, the failed readiness
  // explanation must remain available without clipping the action bar.
  await mp.locator('.qc-advanced summary').click();
  await mp.locator('#qc-datetime').fill('2027-02-14T14:30');
  await mp.route('**/api/posts/*/ready', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    await route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({
        error: 'Пост не готов к публикации',
        issues: [
          { platform: 'telegram', accountId: accounts[0].id, accountName: 'Account 0',
            message: 'Нет права отправки видео', severity: 'error' },
          { platform: 'vk', accountId: accounts[2].id, accountName: 'Account 2',
            message: 'Формат видео не поддерживается этим подключением', severity: 'error' }
        ]
      })
    });
  });
  mp.once('dialog', (dialog) => dialog.accept());
  await mp.locator('#qc-schedule').click();
  await mp.locator('#qc-preflight-issues:not([hidden])').waitFor({ timeout: 45000 });
  assert.equal(await mp.locator('#qc-preflight-issues li').count(), 2);
  assert.match(await mp.locator('#qc-preflight-issues').textContent(), /Нет права отправки видео/);
  assert.match(await mp.locator('#qc-preflight-issues').textContent(), /Формат видео не поддерживается/);
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    '390px failure diagnostics must not introduce horizontal overflow');
  await mp.screenshot({ path: 'test-results/p0-composer-mobile-per-account-ready-errors.png', fullPage: false });
  await mp.unroute('**/api/posts/*/ready');
  assert.deepEqual(errors, []);
  await mobile.close();

  for (const width of [320, 768]) {
    const responsive = await browser.newContext({
      viewport: { width, height: 720 }, isMobile: width === 320, hasTouch: width === 320
    });
    const rp = await responsive.newPage();
    rp.on('pageerror', (error) => errors.push(String(error)));
    await rp.goto('http://127.0.0.1:18889/');
    await rp.locator('#login-form:not(.hidden)').waitFor();
    await rp.locator('#password').fill('composer-e2e-legacy-password-2026');
    await rp.locator('#login-form button[type="submit"]').click();
    await rp.locator('#app:not(.hidden)').waitFor();
    await rp.evaluate(() => window.PublikatorQuickComposer.open());
    await rp.locator('#qc-text').waitFor();
    assert.equal(await rp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      'full-page horizontal overflow at ' + width + 'px');
    await rp.locator('#qc-target-toggle').click();
    const geometry = await rp.locator('#qc-target-picker').boundingBox();
    assert.ok(geometry && geometry.x >= -1 && geometry.width <= width + 1,
      'recipient sheet must fit ' + width + 'px screen without cropping');
    await rp.locator('input[name="qc-account"]').nth(1).check();
    await rp.screenshot({ path: 'test-results/p0-composer-responsive-' + width + '.png', fullPage: false });
    await rp.keyboard.press('Escape');
    assert.equal(await rp.locator('#qc-target-picker').isVisible(), false,
      'Escape must close only the recipient sheet at ' + width + 'px');
    assert.equal(await rp.locator('#qc-text').isVisible(), true,
      'Escape must not dismiss the entire editor');
    assert.equal(await rp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (width === 320) {
      await rp.locator('#qc-video-file').setInputFiles([
        { name: 'narrow-mobile.mp4', mimeType: 'video/mp4', buffer: mp4 }
      ]);
      await rp.locator('#qc-video-preview video').scrollIntoViewIfNeeded();
      const videoBounds = await rp.locator('.qc-video-card').boundingBox();
      assert.ok(videoBounds && videoBounds.x >= -1 && videoBounds.x + videoBounds.width <= width + 1,
        '320px video preview must fit without clipping');
      assert.equal(await rp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await rp.screenshot({ path: 'test-results/p0-composer-video-responsive-320.png', fullPage: false });
      await rp.locator('#qc-platform-preview-load').click();
      await rp.locator('#qc-platform-preview:not([hidden])').waitFor({ timeout: 30000 });
      assert.equal(await rp.locator('.qc-platform-media video').count(), 1);
      assert.equal(await rp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
        '320px local per-account preview must not overflow horizontally');
    }
    await responsive.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    ok: true, oneScreen: true, preSaveImages: true, mediaCount: 2, mp4BeforeSave: true,
    mp4Recovery: true, noMixedMedia: true,
    multiAccount: 3, samePlatformAccounts: 2, noRequiredTitle: true,
    textOnly: true, cancelledSend: true, noPublicPost: true, mobile: true,
    mobileRecipientsSheet: true, responsiveViewports: [320, 390, 768, 1440],
    screenshots: [
      'test-results/p0-composer-video-desktop.png',
      'test-results/p0-composer-video-mobile.png',
      'test-results/p0-composer-local-preview-desktop.png',
      'test-results/p0-composer-local-preview-mobile.png',
      'test-results/p0-composer-per-account-text-variant.png',
      'test-results/p0-composer-variant-inherited-again.png',
      'test-results/p0-composer-platform-preview-desktop.png',
      'test-results/p0-composer-platform-preview-mobile.png',
      'test-results/p0-composer-mobile-per-account-ready-errors.png',
      'test-results/p0-composer-per-account-ready-errors.png',
      'test-results/p0-composer-video-responsive-320.png',
      'test-results/p0-composer-desktop.png',
      'test-results/p0-composer-mobile.png',
      'test-results/p0-composer-mobile-targets.png',
      'test-results/p0-composer-responsive-320.png',
      'test-results/p0-composer-responsive-768.png'
    ]
  }));
} finally {
  if (browser) await browser.close();
  await app.close();
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
}
