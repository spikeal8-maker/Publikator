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

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const sharp = (await import('sharp')).default;
const { saveImageVersioned } = await import('../dist/media.js');
const { buildApp } = await import('../dist/app.js');
const { config } = await import('../dist/config.js');
const { publishPost } = await import('../dist/publisher.js');
const { markReadyRevision } = await import('../dist/content-versioning.js');
const { setPublisherForTests } = await import('../dist/platforms/index.js');
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

async function createContentFixture(title, {
  scheduleMode = 'MANUAL',
  scheduledAtLocal = null,
  scheduleTimezone = 'UTC',
  status = 'DRAFT',
  editorialStage = 'IDEA',
  sourceType = 'manual'
} = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/posts',
    headers: { cookie: fixtureCookie },
    payload: {
      projectId: fixtureProjectId,
      title,
      body: `${title} body`,
      scheduleMode,
      ...(scheduledAtLocal ? { scheduledAtLocal, scheduleTimezone } : {})
    }
  });
  assert.equal(response.statusCode, 201, response.body);
  const post = response.json();
  db.prepare('UPDATE posts SET source_type=?,editorial_stage=?,status=? WHERE id=?')
    .run(sourceType, editorialStage, status, post.id);
  return post;
}

const contentDraftTitle = 'Browser Content Draft Manual';
const contentReadyTitle = 'Browser Content Ready Queue';
const contentFailedTitle = 'Browser Content Failed Manual';
const contentDraft = await createContentFixture(contentDraftTitle, { scheduleMode: 'MANUAL', status: 'DRAFT', editorialStage: 'IN_REVIEW' });
await createContentFixture(contentReadyTitle, { scheduleMode: 'QUEUE', status: 'READY', editorialStage: 'APPROVED' });
await createContentFixture(contentFailedTitle, { scheduleMode: 'MANUAL', status: 'FAILED', editorialStage: 'APPROVED' });

const editorAccountId = id('acc');
db.prepare(`INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`)
  .run(editorAccountId, 'telegram', 'Browser editor channel', encryptJson({ botToken: 'browser-token', chatId: '@browser' }), nowIso(), nowIso());
db.prepare(`INSERT INTO project_default_targets (project_id,account_id,created_at) VALUES (?,?,?)`)
  .run(fixtureProjectId, editorAccountId, nowIso());
db.prepare(`INSERT INTO post_targets (id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (?,?,?,1,'PENDING',0,?)`)
  .run(id('target'), contentDraft.id, editorAccountId, nowIso());

const calendarFixtureTitle = 'Browser Calendar Presentation';
const calendarWhen = new Date(Date.now() + 60 * 60 * 1000);
const calendarScheduledAtLocal = calendarWhen.toISOString().slice(0, 16);
const calendarFixture = await createContentFixture(calendarFixtureTitle, {
  scheduleMode: 'AT',
  scheduledAtLocal: calendarScheduledAtLocal,
  scheduleTimezone: 'UTC',
  status: 'READY',
  editorialStage: 'IN_REVIEW',
  sourceType: 'google_sheets'
});

async function fixtureApi(method, url, payload, expected = 200) {
  const response = await app.inject({ method, url, headers: { cookie: fixtureCookie }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(response.statusCode, expected, `fixture ${method} ${url}: ${response.body}`);
  return response.json();
}

const revisionHistoryTitle = 'Browser Revision History';
const revisionPost = await fixtureApi('POST', '/api/posts', {
  projectId: fixtureProjectId,
  title: revisionHistoryTitle,
  body: 'Revision body A',
  scheduleMode: 'MANUAL'
}, 201);
const revisionV1 = db.prepare('SELECT id FROM content_revisions WHERE post_id=? AND content_version=1').get(revisionPost.id);
assert.ok(revisionV1);

const revisionV2 = await fixtureApi('PATCH', `/api/posts/${revisionPost.id}`, {
  title: revisionHistoryTitle,
  body: 'Revision body B',
  scheduleMode: 'AT',
  scheduledAt: '2026-12-11T10:15:00.000Z',
  scheduleTimezone: 'UTC',
  expectedContentVersion: 1
});
assert.equal(revisionV2.contentVersion, 2);
const revisionPostView = await fixtureApi('GET', `/api/posts/${revisionPost.id}`);
const revisionTarget = revisionPostView.targets.find((target) => target.account_id === editorAccountId);
assert.ok(revisionTarget);
const revisionV3 = await fixtureApi('PATCH', `/api/posts/${revisionPost.id}/targets/${revisionTarget.id}/text`, {
  text: 'Revision target override',
  expectedContentVersion: 2
});
assert.equal(revisionV3.contentVersion, 3);
assert.deepEqual(
  db.prepare('SELECT content_version FROM content_revisions WHERE post_id=? ORDER BY content_version').all(revisionPost.id).map((row) => row.content_version),
  [1,2,3]
);

const staleRevisionRestore = await fixtureApi('POST', `/api/posts/${revisionPost.id}/revisions/${revisionV1.id}/restore`, {
  expectedContentVersion: 2
}, 409);
assert.equal(staleRevisionRestore.code, 'REVISION_CONFLICT');

const mediaBlockedPost = await fixtureApi('POST', '/api/posts', {
  projectId: fixtureProjectId,
  title: 'Browser Revision Media Block',
  body: 'Media revision body',
  scheduleMode: 'MANUAL'
}, 201);
const mediaBlockedRevision = db.prepare('SELECT id FROM content_revisions WHERE post_id=? AND content_version=1').get(mediaBlockedPost.id);
const mediaBytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 70, g: 90, b: 110 } } }).jpeg().toBuffer();
const richEditorImagePath = path.join(dataDir, 'browser-rich-editor.jpg');
await fs.writeFile(richEditorImagePath, mediaBytes);
await saveImageVersioned(mediaBlockedPost.id, 'history.jpg', mediaBytes, 1);
const readableMediaDiff = await fixtureApi('GET', `/api/posts/${mediaBlockedPost.id}/revisions/${mediaBlockedRevision.id}/diff`);
assert.equal(readableMediaDiff.restoreCompatibility.code, 'REVISION_MEDIA_INCOMPATIBLE');
const mediaBlockedRestore = await fixtureApi('POST', `/api/posts/${mediaBlockedPost.id}/revisions/${mediaBlockedRevision.id}/restore`, {
  expectedContentVersion: 2
}, 409);
assert.equal(mediaBlockedRestore.code, 'REVISION_MEDIA_INCOMPATIBLE');

const publishedHistoryPost = await fixtureApi('POST', '/api/posts', {
  projectId: fixtureProjectId,
  title: 'Browser Revision Published',
  body: 'Published history A',
  scheduleMode: 'MANUAL'
}, 201);
const publishedRevision = db.prepare('SELECT id FROM content_revisions WHERE post_id=? AND content_version=1').get(publishedHistoryPost.id);
await fixtureApi('PATCH', `/api/posts/${publishedHistoryPost.id}`, {
  body: 'Published history B',
  expectedContentVersion: 1
});
db.prepare("UPDATE posts SET status='PUBLISHED',editorial_stage='APPROVED' WHERE id=?").run(publishedHistoryPost.id);
const publishedReadableDiff = await fixtureApi('GET', `/api/posts/${publishedHistoryPost.id}/revisions/${publishedRevision.id}/diff`);
assert.equal(publishedReadableDiff.restoreCompatibility.code, 'REVISION_PUBLISHED_IMMUTABLE');
const publishedBlockedRestore = await fixtureApi('POST', `/api/posts/${publishedHistoryPost.id}/revisions/${publishedRevision.id}/restore`, {
  expectedContentVersion: 2
}, 409);
assert.equal(publishedBlockedRestore.code, 'REVISION_PUBLISHED_IMMUTABLE');

const browserPlatformAccounts = { telegram: editorAccountId };
for (const [platform, credentials, name] of [
  ['max', { accessToken: 'browser-max-token', chatId: '-100500' }, 'Browser MAX'],
  ['vk', { accessToken: 'browser-vk-token', groupId: '12345', apiVersion: '5.199' }, 'Browser VK'],
  ['instagram', { accessToken: 'browser-instagram-token', igUserId: '17841400000000000', graphVersion: 'v24.0' }, 'Browser Instagram']
]) {
  const accountId = id('acc');
  browserPlatformAccounts[platform] = accountId;
  const createdAt = nowIso();
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`)
    .run(accountId, platform, name, encryptJson(credentials), createdAt, createdAt);
  db.prepare(`INSERT INTO project_default_targets (project_id,account_id,created_at) VALUES (?,?,?)`)
    .run(fixtureProjectId, accountId, createdAt);
  db.prepare(`INSERT INTO post_targets (id,post_id,account_id,enabled,state,attempts,updated_at)
    VALUES (?,?,?,0,'PENDING',0,?)`)
    .run(id('target'), contentDraft.id, accountId, createdAt);
}

const ew4005Project = await fixtureApi('POST', '/api/projects', {
  name: 'Browser EW4-005 Project',
  slug: 'browser-ew4-005'
}, 201);

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

  const selectEditorText = async (needle) => {
    const found = await page.evaluate((text) => {
      const surface = document.querySelector('[data-rich-text-editor] .rich-text-surface');
      if (!surface) return false;
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const index = String(node.nodeValue || '').indexOf(text);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      }
      return false;
    }, needle);
    assert.equal(found, true, `rich editor text not found: ${needle}`);
  };
  const richCommand = async (needle, command, promptValue = null) => {
    await selectEditorText(needle);
    if (promptValue !== null) page.once('dialog', (dialog) => dialog.accept(promptValue));
    await page.locator(`[data-rich-text-editor] [data-rich-command="${command}"]`).click();
  };

  const selectPlatformText = async (platform, needle) => {
    const found = await page.evaluate(({ platformName, text }) => {
      const surface = document.querySelector(`.platform-editor-card[data-platform="${platformName}"] .rich-text-surface`);
      if (!surface) return false;
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const index = String(node.nodeValue || '').indexOf(text);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      }
      return false;
    }, { platformName: platform, text: needle });
    assert.equal(found, true, `platform editor text not found: ${platform} / ${needle}`);
  };

  await page.goto(`${base}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).pathname, '/calendar', 'direct route must survive unauthenticated bootstrap');
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#app').waitFor({ state: 'visible' });
  // Keep browser origin HTTP, but make publication media URLs satisfy real HTTPS capability gates.
  // Login cookie was already created with the HTTP test base.
  config.publicBaseUrl = 'https://publisher.example.test';
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

  // EW4-006: real Post Template library and snapshot creation.
  await page.goto(`${base}/templates`, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Шаблоны');
  assert.equal(await page.getByText('Шаблоны пока не включены').count(), 0, 'templates placeholder must be removed');

  await page.locator('#operator-new-template').click();
  let templateForm = page.locator('#operator-template-form');
  await templateForm.waitFor({ state: 'visible' });
  assert.equal(await templateForm.locator('[data-template-rich-editor] .rich-text-surface').count(), 1, 'template must reuse canonical rich editor');
  assert.ok(await templateForm.locator('[data-template-rich-editor] .rich-text-toolbar button').count() >= 10, 'template rich toolbar missing');
  await templateForm.locator('input[name="name"]').fill('Browser Template Snapshot');
  await templateForm.locator('input[name="key"]').fill('browser-template-snapshot');
  await templateForm.locator('select[name="projectId"]').selectOption(fixtureProjectId);
  await templateForm.locator('select[name="publicationKind"]').selectOption('FEED');
  await templateForm.locator('select[name="contentFormat"]').selectOption('TEXT_ONLY');
  await templateForm.locator('select[name="scheduleMode"]').selectOption('MANUAL');
  const templateSurface = templateForm.locator('[data-template-rich-editor] .rich-text-surface');
  await templateSurface.fill('Browser Template V1');
  await templateForm.locator('#operator-template-project-defaults').uncheck();
  await templateForm.locator(`input[name="templateTarget"][value="${editorAccountId}"]`).check();
  await templateForm.locator(`input[name="templateTarget"][value="${browserPlatformAccounts.vk}"]`).check();
  await templateForm.locator('button.primary[type="submit"]').click();
  await page.locator('#operator-template-form').waitFor({ state: 'detached', timeout: 5000 });

  let templateRow = page.locator('#view table.table tbody tr').filter({ hasText: 'Browser Template Snapshot' });
  assert.equal(await templateRow.count(), 1, 'saved template must render once');
  assert.match(await templateRow.innerText(), /Browser editor channel/);
  assert.match(await templateRow.innerText(), /Browser VK/);

  // Re-open before applying to prove persisted editor state.
  await templateRow.locator('.operator-template-edit').click();
  templateForm = page.locator('#operator-template-form');
  await templateForm.waitFor({ state: 'visible' });
  assert.equal(
    (await templateForm.locator('[data-template-rich-editor] .rich-text-surface').innerText()).trim(),
    'Browser Template V1'
  );
  assert.equal(await templateForm.locator(`input[name="templateTarget"][value="${editorAccountId}"]`).isChecked(), true);
  assert.equal(await templateForm.locator(`input[name="templateTarget"][value="${browserPlatformAccounts.vk}"]`).isChecked(), true);
  await templateForm.locator('#operator-template-cancel').click();
  await page.locator('#operator-template-form').waitFor({ state: 'detached', timeout: 5000 });

  templateRow = page.locator('#view table.table tbody tr').filter({ hasText: 'Browser Template Snapshot' });
  await templateRow.locator('.operator-template-create-post').click();
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Контент');
  const postA = db.prepare(`SELECT id,body,content_version,status,editorial_stage FROM posts
    WHERE title=? ORDER BY rowid DESC LIMIT 1`).get('Browser Template Snapshot');
  assert.ok(postA?.id);
  assert.equal(postA.body, 'Browser Template V1');
  assert.equal(postA.content_version, 1);
  assert.equal(postA.status, 'DRAFT');
  assert.equal(postA.editorial_stage, 'DRAFT');
  const templateTargetIds = (postId) => db.prepare(
    'SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1 ORDER BY account_id'
  ).all(postId).map((row) => row.account_id);
  assert.deepEqual(templateTargetIds(postA.id), [editorAccountId, browserPlatformAccounts.vk].sort());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(postA.id).count, 1);
  const postARevisionCount = db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(postA.id).count;

  await page.goto(`${base}/templates`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Шаблоны');
  templateRow = page.locator('#view table.table tbody tr').filter({ hasText: 'Browser Template Snapshot' });
  await templateRow.locator('.operator-template-edit').click();
  templateForm = page.locator('#operator-template-form');
  await templateForm.waitFor({ state: 'visible' });
  await templateForm.locator('[data-template-rich-editor] .rich-text-surface').fill('Browser Template V2');
  await templateForm.locator(`input[name="templateTarget"][value="${editorAccountId}"]`).uncheck();
  await templateForm.locator(`input[name="templateTarget"][value="${browserPlatformAccounts.vk}"]`).uncheck();
  await templateForm.locator(`input[name="templateTarget"][value="${browserPlatformAccounts.max}"]`).check();
  await templateForm.locator('button.primary[type="submit"]').click();
  await page.locator('#operator-template-form').waitFor({ state: 'detached', timeout: 5000 });

  const postAAfterTemplateEdit = db.prepare('SELECT body,content_version FROM posts WHERE id=?').get(postA.id);
  assert.equal(postAAfterTemplateEdit.body, 'Browser Template V1');
  assert.equal(postAAfterTemplateEdit.content_version, 1);
  assert.deepEqual(templateTargetIds(postA.id), [editorAccountId, browserPlatformAccounts.vk].sort());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(postA.id).count, postARevisionCount);

  templateRow = page.locator('#view table.table tbody tr').filter({ hasText: 'Browser Template Snapshot' });
  assert.match(await templateRow.innerText(), /Browser MAX/);
  await templateRow.locator('.operator-template-create-post').click();
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Контент');
  const postB = db.prepare(`SELECT id,body,content_version,status FROM posts
    WHERE title=? AND id<>? ORDER BY rowid DESC LIMIT 1`).get('Browser Template Snapshot', postA.id);
  assert.ok(postB?.id);
  assert.equal(postB.body, 'Browser Template V2');
  assert.equal(postB.content_version, 1);
  assert.equal(postB.status, 'DRAFT');
  assert.deepEqual(templateTargetIds(postB.id), [browserPlatformAccounts.max]);

  await page.waitForFunction((title) => [...document.querySelectorAll('#view table.table tbody tr')]
    .some((row) => row.textContent?.includes(title)), 'Browser Template Snapshot');

  // EW4-005: Project defaults are operable through the existing /projects page.
  await page.goto(`${base}/projects`, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Проекты');
  await page.waitForFunction(() => [...document.querySelectorAll('#view table.table thead th')]
    .some((cell) => cell.textContent?.trim() === 'Slug'));
  const projectHeaders = await page.locator('#view table.table thead th').allTextContents();
  for (const expected of ['Название','Slug','Часовой пояс','Площадки по умолчанию','Действие']) {
    assert.ok(projectHeaders.includes(expected), `Projects column missing: ${expected}`);
  }

  let ewProjectRow = page.locator('#view table.table tbody tr').filter({ hasText: ew4005Project.name });
  assert.equal(await ewProjectRow.count(), 1, 'EW4-005 browser project must render once');
  assert.match(await ewProjectRow.innerText(), /UTC/);
  assert.match(await ewProjectRow.innerText(), /Telegram \/ Browser editor channel/);
  assert.match(await ewProjectRow.innerText(), /VK \/ Browser VK/);
  assert.match(await ewProjectRow.innerText(), /MAX \/ Browser MAX/);

  await ewProjectRow.locator('.project-settings').click();
  let projectSettingsForm = page.locator('#project-settings-form');
  await projectSettingsForm.waitFor({ state: 'visible' });
  assert.equal(await projectSettingsForm.locator('input[name="defaultTimezone"]').inputValue(), 'UTC');
  const projectTargetBoxes = projectSettingsForm.locator('input[name="defaultTargetAccountId"]');
  assert.equal(await projectTargetBoxes.count(), 4, 'Project settings must show all existing social accounts');
  await projectTargetBoxes.evaluateAll((inputs) => inputs.forEach((input) => { input.checked = false; }));
  await projectSettingsForm.locator('#select-all-enabled').click();
  assert.equal(await projectSettingsForm.locator('input[name="defaultTargetAccountId"]:checked').count(), 4, 'Select all enabled must select every enabled account');

  // Explicit empty is a real user state and must survive a backend round-trip.
  await projectTargetBoxes.evaluateAll((inputs) => inputs.forEach((input) => { input.checked = false; }));
  await projectSettingsForm.locator('button.primary[type="submit"]').click();
  await page.locator('#project-settings-form').waitFor({ state: 'detached', timeout: 5000 });
  let projectFromApi = (await fixtureApi('GET', '/api/projects')).find((project) => project.id === ew4005Project.id);
  assert.equal(projectFromApi.default_targets_explicit, 1);
  assert.deepEqual(projectFromApi.defaultTargetAccountIds, []);

  ewProjectRow = page.locator('#view table.table tbody tr').filter({ hasText: ew4005Project.name });
  assert.match(await ewProjectRow.innerText(), /Не выбраны/);
  await ewProjectRow.locator('.project-settings').click();
  projectSettingsForm = page.locator('#project-settings-form');
  await projectSettingsForm.waitFor({ state: 'visible' });
  assert.equal(await projectSettingsForm.locator('input[name="defaultTargetAccountId"]:checked').count(), 0, 'Explicit empty defaults must hydrate as empty');

  await projectSettingsForm.locator('input[name="defaultTimezone"]').fill('Europe/Moscow');
  await projectSettingsForm.locator(`input[name="defaultTargetAccountId"][value="${editorAccountId}"]`).check();
  await projectSettingsForm.locator(`input[name="defaultTargetAccountId"][value="${browserPlatformAccounts.vk}"]`).check();
  await projectSettingsForm.locator('button.primary[type="submit"]').click();
  await page.locator('#project-settings-form').waitFor({ state: 'detached', timeout: 5000 });

  projectFromApi = (await fixtureApi('GET', '/api/projects')).find((project) => project.id === ew4005Project.id);
  assert.equal(projectFromApi.default_timezone, 'Europe/Moscow');
  assert.equal(projectFromApi.default_targets_explicit, 1);
  assert.deepEqual(
    [...projectFromApi.defaultTargetAccountIds].sort(),
    [editorAccountId, browserPlatformAccounts.vk].sort()
  );
  ewProjectRow = page.locator('#view table.table tbody tr').filter({ hasText: ew4005Project.name });
  const projectRowText = await ewProjectRow.innerText();
  assert.ok(projectRowText.includes('Europe/Moscow'));
  assert.ok(projectRowText.includes('Telegram / Browser editor channel'));
  assert.ok(projectRowText.includes('VK / Browser VK'));
  assert.ok(!projectRowText.includes('MAX / Browser MAX'));

  await page.goto(`${base}/content`, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Контент');
  await page.locator('#ui-content-filter').waitFor({ state: 'visible' });

  const contentRow = (title) => page.locator('#view table.table tbody tr').filter({ hasText: title });
  const draftRow = contentRow(contentDraftTitle);
  const readyRow = contentRow(contentReadyTitle);
  const failedRow = contentRow(contentFailedTitle);
  for (const row of [draftRow, readyRow, failedRow]) assert.equal(await row.count(), 1, 'seeded Content fixture must render once');

  const verifyContentRow = async (row, visibleStatus, rawStatus, visibleSchedule, rawSchedule) => {
    const statusBadge = row.locator('td').nth(4).locator('.badge');
    const scheduleCell = row.locator('td').nth(3);
    assert.equal((await statusBadge.textContent())?.trim(), visibleStatus);
    assert.equal(await statusBadge.getAttribute('data-raw-status'), rawStatus);
    assert.equal((await scheduleCell.textContent())?.trim(), visibleSchedule);
    assert.equal(await scheduleCell.getAttribute('data-raw-schedule'), rawSchedule);
    const visibleText = await row.innerText();
    assert.ok(!visibleText.includes(rawStatus), `Content row exposes raw status: ${rawStatus}`);
    assert.ok(!visibleText.includes(rawSchedule), `Content row exposes raw schedule mode: ${rawSchedule}`);
  };
  await verifyContentRow(draftRow, 'Черновик', 'DRAFT', 'Вручную', 'MANUAL');
  await verifyContentRow(readyRow, 'Готово', 'READY', 'Очередь', 'QUEUE');
  await verifyContentRow(failedRow, 'Ошибка', 'FAILED', 'Вручную', 'MANUAL');

  const filterStatus = async (status) => {
    await page.locator(`#ui-content-filter [data-status="${status}"]`).click();
    await page.waitForFunction((selected) => document.querySelector(`#ui-content-filter [data-status="${selected}"]`)?.classList.contains('active'), status);
  };
  await filterStatus('DRAFT');
  assert.equal(await draftRow.isVisible(), true);
  assert.equal(await readyRow.isVisible(), false);
  assert.equal(await failedRow.isVisible(), false);
  await filterStatus('READY');
  assert.equal(await draftRow.isVisible(), false);
  assert.equal(await readyRow.isVisible(), true);
  await filterStatus('PROBLEM');
  assert.equal(await failedRow.isVisible(), true);
  assert.equal(await readyRow.isVisible(), false);
  await filterStatus('ALL');
  assert.equal(await draftRow.isVisible(), true);
  assert.equal(await readyRow.isVisible(), true);
  assert.equal(await failedRow.isVisible(), true);


  // EW4-006 Reusable Blocks: library, project filtering, caret insertion and snapshot semantics.
  await page.goto(`${base}/templates`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Шаблоны');
  await page.locator('[data-template-section="reusable-blocks"]').waitFor({ state: 'visible' });

  await page.locator('.operator-new-block[data-template-type="CTA"]').click();
  let reusableForm = page.locator('#operator-reusable-form');
  await reusableForm.waitFor({ state: 'visible' });
  await reusableForm.locator('input[name="name"]').fill('Browser CTA V1');
  await reusableForm.locator('input[name="key"]').fill('browser-cta');
  await reusableForm.locator('select[name="projectId"]').selectOption(fixtureProjectId);
  const reusableSurface = reusableForm.locator('[data-reusable-rich-editor] .rich-text-surface');
  await reusableSurface.fill('Записаться сейчас');
  await reusableForm.locator('button.primary[type="submit"]').click();
  await page.locator('#operator-reusable-form').waitFor({ state: 'detached', timeout: 5000 });

  const browserCta=(await fixtureApi('GET','/api/templates')).find((item)=>item.key==='browser-cta');
  assert.ok(browserCta);
  assert.equal(browserCta.templateType,'CTA');
  assert.equal(browserCta.projectId,fixtureProjectId);
  assert.equal(browserCta.publicationKind,'FEED');
  assert.equal(browserCta.contentFormat,'TEXT_ONLY');
  assert.equal(browserCta.scheduleMode,'MANUAL');
  assert.equal(browserCta.targetAccountIds,null);

  const browserSnippet=await fixtureApi('POST','/api/templates',{
    key:'browser-snippet',name:'Browser Snippet',projectId:fixtureProjectId,
    bodyRich:{type:'doc',content:[
      {type:'paragraph',content:[
        {type:'text',text:'Фрагмент ',marks:[{type:'code'}]},
        {type:'link',attrs:{href:'https://example.test/docs'},content:[{type:'text',text:'документация',marks:[{type:'italic'}]}]}
      ]},
      {type:'bullet_list',content:[{type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'Шаг',marks:[]}]}]}]},
      {type:'blockquote',content:[{type:'paragraph',content:[{type:'text',text:'Важно',marks:[]}]}]},
      {type:'code_block',content:[{type:'text',text:'const x = 1;',marks:[]}]}
    ]},
    templateType:'SNIPPET'
  },201);
  const browserSignature=await fixtureApi('POST','/api/templates',{
    key:'browser-signature',name:'Browser Signature',projectId:fixtureProjectId,
    bodyRich:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'ASA Lab',marks:[{type:'bold'}]}]}]},
    templateType:'SIGNATURE'
  },201);
  const browserHashtags=await fixtureApi('POST','/api/templates',{
    key:'browser-hashtags',name:'Browser Hashtags',projectId:fixtureProjectId,
    bodyRich:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'#robotics #arduino',marks:[]}]}]},
    templateType:'HASHTAG_SET'
  },201);
  const otherProjectCta=await fixtureApi('POST','/api/templates',{
    key:'browser-other-cta',name:'Other Project CTA',projectId:ew4005Project.id,
    bodyRich:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Другой проект',marks:[]}]}]},
    templateType:'CTA'
  },201);

  await page.goto(`${base}/templates`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-template-section="reusable-blocks"]').waitFor({ state: 'visible' });
  const reusableSection=page.locator('[data-template-section="reusable-blocks"]');
  const reusableHeaders=await reusableSection.locator('thead th').allTextContents();
  assert.deepEqual(reusableHeaders,['Название','Key','Проект','Тип','Превью текста','Изменён','Действия']);
  for(const [name,label] of [
    ['Browser Snippet','Фрагмент'],
    ['Browser CTA V1','CTA'],
    ['Browser Signature','Подпись'],
    ['Browser Hashtags','Набор хэштегов']
  ]){
    const row=reusableSection.locator('tbody tr').filter({hasText:name});
    assert.equal(await row.count(),1,`reusable row missing: ${name}`);
    assert.ok((await row.innerText()).includes(label),`wrong reusable type label: ${name}`);
  }

  const reusablePostA=await fixtureApi('POST','/api/posts',{
    projectId:fixtureProjectId,
    title:'Browser Reusable Post A',
    body:'До после',
    scheduleMode:'MANUAL'
  },201);
  const reusablePostARevision=db.prepare(
    'SELECT id FROM content_revisions WHERE post_id=? AND content_version=1'
  ).get(reusablePostA.id);
  markReadyRevision(reusablePostA.id,1,reusablePostARevision.id);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(reusablePostA.id).status,'READY');

  await page.goto(`${base}/content`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Контент');
  await page.waitForFunction((title)=>[...document.querySelectorAll('#view table.table tbody tr')]
    .some((row)=>row.textContent?.includes(title)),'Browser Reusable Post A');
  await page.locator('#view table.table tbody tr').filter({hasText:'Browser Reusable Post A'}).locator('.open-post').click();
  let reusableInspector=page.locator('.editorial-inspector-overlay');
  await reusableInspector.waitFor({state:'visible',timeout:5000});
  await reusableInspector.locator('.inspector-edit').click();
  await reusableInspector.waitFor({state:'detached',timeout:5000});

  let reusablePostForm=page.locator('#post-form');
  await reusablePostForm.waitFor({state:'visible'});
  const baseSurface=reusablePostForm.locator('[data-rich-text-editor] .rich-text-surface');
  assert.equal((await baseSurface.innerText()).trim(),'До после');
  const caretSet=await page.evaluate(() => {
    const surface=document.querySelector('#post-form [data-rich-text-editor] .rich-text-surface');
    const walker=document.createTreeWalker(surface,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){
      const node=walker.currentNode;
      const text=String(node.nodeValue||'');
      const index=text.indexOf(' после');
      if(index<0)continue;
      const range=document.createRange();
      range.setStart(node,index);
      range.collapse(true);
      const selection=window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      surface.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      return true;
    }
    return false;
  });
  assert.equal(caretSet,true,'caret insertion point missing');

  await reusablePostForm.locator('#toggle-reusable-blocks').click();
  let reusableSelect=reusablePostForm.locator('#reusable-block-select');
  assert.equal(await reusableSelect.locator('optgroup[label="Фрагменты"]').count(),1);
  assert.equal(await reusableSelect.locator('optgroup[label="CTA"]').count(),1);
  assert.equal(await reusableSelect.locator('optgroup[label="Подписи"]').count(),1);
  assert.equal(await reusableSelect.locator('optgroup[label="Хэштеги"]').count(),1);
  assert.equal(await reusableSelect.locator(`option[value="${browserCta.id}"]`).count(),1);
  assert.equal(await reusableSelect.locator(`option[value="${otherProjectCta.id}"]`).count(),0);
  await reusableSelect.selectOption(browserCta.id);
  await reusablePostForm.locator('#apply-reusable-block').click();

  const insertedText=(await baseSurface.innerText()).trim();
  assert.ok(insertedText.indexOf('До') < insertedText.indexOf('Записаться сейчас'));
  assert.ok(insertedText.indexOf('Записаться сейчас') < insertedText.indexOf('после'));

  await reusablePostForm.locator('#toggle-reusable-blocks').click();
  reusableSelect=reusablePostForm.locator('#reusable-block-select');
  await reusableSelect.selectOption(browserSignature.id);
  await reusablePostForm.locator('#apply-reusable-block').click();
  assert.equal(await baseSurface.locator('strong').filter({hasText:'ASA Lab'}).count(),1);

  await reusablePostForm.locator('#toggle-reusable-blocks').click();
  reusableSelect=reusablePostForm.locator('#reusable-block-select');
  await reusableSelect.selectOption(browserSnippet.id);
  await reusablePostForm.locator('#apply-reusable-block').click();
  assert.equal(await baseSurface.locator('a[href="https://example.test/docs"]').count(),1);
  assert.equal(await baseSurface.locator('ul li').filter({hasText:'Шаг'}).count(),1);
  assert.equal(await baseSurface.locator('blockquote').filter({hasText:'Важно'}).count(),1);
  assert.equal(await baseSurface.locator('pre').filter({hasText:'const x = 1;'}).count(),1);
  assert.equal(await baseSurface.locator('code').filter({hasText:'Фрагмент'}).count(),1);

  await reusablePostForm.locator('#toggle-reusable-blocks').click();
  await reusablePostForm.locator('select[name="projectId"]').selectOption(ew4005Project.id);
  reusableSelect=reusablePostForm.locator('#reusable-block-select');
  assert.equal(await reusableSelect.locator(`option[value="${browserCta.id}"]`).count(),0);
  assert.equal(await reusableSelect.locator(`option[value="${otherProjectCta.id}"]`).count(),1);
  assert.ok((await baseSurface.innerText()).includes('Записаться сейчас'));
  await reusablePostForm.locator('select[name="projectId"]').selectOption(fixtureProjectId);
  assert.equal(await reusableSelect.locator(`option[value="${browserCta.id}"]`).count(),1);

  await reusablePostForm.locator('button.primary[type="submit"]').click();
  await page.locator('#post-form').waitFor({state:'detached',timeout:5000});
  const savedReusableA=db.prepare(
    'SELECT body,body_rich_json,content_version,status,editorial_stage FROM posts WHERE id=?'
  ).get(reusablePostA.id);
  assert.equal(savedReusableA.content_version,2);
  assert.equal(savedReusableA.status,'DRAFT');
  assert.equal(savedReusableA.editorial_stage,'DRAFT');
  assert.ok(savedReusableA.body.includes('Записаться сейчас'));
  assert.ok(!savedReusableA.body.includes('Записаться на новый курс'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE post_id=?').get(reusablePostA.id).count,2);
  const postARichSnapshot=savedReusableA.body_rich_json;

  await page.goto(`${base}/templates`,{waitUntil:'domcontentloaded'});
  await page.locator('[data-template-section="reusable-blocks"]').waitFor({state:'visible'});
  let ctaRow=page.locator('[data-template-section="reusable-blocks"] tbody tr').filter({hasText:'Browser CTA V1'});
  await ctaRow.locator('.operator-template-edit').click();
  reusableForm=page.locator('#operator-reusable-form');
  await reusableForm.waitFor({state:'visible'});
  await reusableForm.locator('input[name="name"]').fill('Browser CTA V2');
  await reusableForm.locator('[data-reusable-rich-editor] .rich-text-surface').fill('Записаться на новый курс');
  await reusableForm.locator('button.primary[type="submit"]').click();
  await page.locator('#operator-reusable-form').waitFor({state:'detached',timeout:5000});
  const browserCtaV2=(await fixtureApi('GET','/api/templates')).find((item)=>item.id===browserCta.id);
  assert.equal(browserCtaV2.bodyPlain,'Записаться на новый курс');
  assert.equal(db.prepare('SELECT body_rich_json FROM posts WHERE id=?').get(reusablePostA.id).body_rich_json,postARichSnapshot);

  await page.goto(`${base}/content`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Контент');
  await page.locator('#new-post').click();
  let newReusablePostForm=page.locator('#post-form');
  await newReusablePostForm.waitFor({state:'visible'});
  await newReusablePostForm.locator('select[name="projectId"]').selectOption(fixtureProjectId);
  await newReusablePostForm.locator('input[name="title"]').fill('Browser Reusable Post B');
  await newReusablePostForm.locator('[data-rich-text-editor] .rich-text-surface').fill('Начало B');
  await newReusablePostForm.locator('#toggle-reusable-blocks').click();
  await newReusablePostForm.locator('#reusable-block-select').selectOption(browserCta.id);
  await newReusablePostForm.locator('#apply-reusable-block').click();
  assert.ok((await newReusablePostForm.locator('[data-rich-text-editor] .rich-text-surface').innerText()).includes('Записаться на новый курс'));
  await newReusablePostForm.locator('button.primary[type="submit"]').click();
  await page.locator('#post-form').waitFor({state:'detached',timeout:5000});

  const savedReusableB=db.prepare(
    'SELECT id,body,body_rich_json,content_version FROM posts WHERE title=? ORDER BY rowid DESC LIMIT 1'
  ).get('Browser Reusable Post B');
  assert.ok(savedReusableB?.id);
  assert.equal(savedReusableB.content_version,1);
  assert.ok(savedReusableB.body.includes('Записаться на новый курс'));
  const postBRichSnapshot=savedReusableB.body_rich_json;

  await page.goto(`${base}/templates`,{waitUntil:'domcontentloaded'});
  await page.locator('[data-template-section="reusable-blocks"]').waitFor({state:'visible'});
  ctaRow=page.locator('[data-template-section="reusable-blocks"] tbody tr').filter({hasText:'Browser CTA V2'});
  page.once('dialog',(dialog)=>dialog.accept());
  await ctaRow.locator('.operator-template-delete').click();
  await page.waitForFunction((id)=>![...document.querySelectorAll('[data-template-section="reusable-blocks"] tbody tr')]
    .some((row)=>row.dataset.templateId===id),browserCta.id);
  assert.equal(db.prepare('SELECT body_rich_json FROM posts WHERE id=?').get(reusablePostA.id).body_rich_json,postARichSnapshot);
  assert.equal(db.prepare('SELECT body_rich_json FROM posts WHERE id=?').get(savedReusableB.id).body_rich_json,postBRichSnapshot);

  await page.goto(`${base}/content`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Контент');
  await page.locator('#new-post').waitFor({state:'visible'});

  // EW4-005: new Post inherits project timezone and targets; per-post override stays isolated.
  const ewInheritedTitle = 'Browser EW4-005 inherited defaults';
  await page.locator('#new-post').click();
  let ewPostForm = page.locator('#post-form');
  await ewPostForm.waitFor({ state: 'visible' });
  await ewPostForm.locator('select[name="projectId"]').selectOption(ew4005Project.id);
  await ewPostForm.locator('select[name="scheduleMode"]').selectOption('AT');
  await ewPostForm.locator('input[name="scheduledAt"]').fill('2026-10-01T18:00');
  await ewPostForm.locator('input[name="title"]').fill(ewInheritedTitle);
  await ewPostForm.locator('[data-rich-text-editor] .rich-text-surface').fill('EW4-005 inherited defaults browser body');
  await ewPostForm.locator('button.primary[type="submit"]').click();
  await page.locator('#post-form').waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForFunction((title) => [...document.querySelectorAll('#view table.table tbody tr')].some((row) => row.textContent?.includes(title)), ewInheritedTitle);

  const ewPost = db.prepare(`SELECT id,schedule_timezone,scheduled_at_utc FROM posts WHERE title=?`).get(ewInheritedTitle);
  assert.ok(ewPost);
  assert.equal(ewPost.schedule_timezone, 'Europe/Moscow');
  assert.equal(ewPost.scheduled_at_utc, '2026-10-01T15:00:00.000Z');
  let ewEnabledTargets = db.prepare(`SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1 ORDER BY account_id`)
    .all(ewPost.id).map((row) => row.account_id);
  assert.deepEqual(ewEnabledTargets, [editorAccountId, browserPlatformAccounts.vk].sort());

  await contentRow(ewInheritedTitle).locator('.open-post').click();
  let ewInspector = page.locator('.editorial-inspector-overlay');
  await ewInspector.waitFor({ state: 'visible', timeout: 5000 });
  await ewInspector.locator('.inspector-edit').click();
  await ewInspector.waitFor({ state: 'detached', timeout: 5000 });
  ewPostForm = page.locator('#post-form');
  await ewPostForm.waitFor({ state: 'visible', timeout: 5000 });
  await ewPostForm.locator('.platform-workspace').waitFor({ state: 'visible', timeout: 5000 });

  const ewTelegramBox = ewPostForm.locator(`input[name="accountId"][value="${editorAccountId}"]`);
  const ewVkBox = ewPostForm.locator(`input[name="accountId"][value="${browserPlatformAccounts.vk}"]`);
  const ewMaxBox = ewPostForm.locator(`input[name="accountId"][value="${browserPlatformAccounts.max}"]`);
  const ewInstagramBox = ewPostForm.locator(`input[name="accountId"][value="${browserPlatformAccounts.instagram}"]`);
  assert.equal(await ewTelegramBox.isChecked(), true);
  assert.equal(await ewVkBox.isChecked(), true);
  assert.equal(await ewMaxBox.isChecked(), false);
  assert.equal(await ewInstagramBox.isChecked(), false);
  assert.equal(
    await ewPostForm.locator('[data-platform-option], [data-platform-options], .platform-option, .platform-options').count(),
    0,
    'empty platformOptionsSchema must not render fake platform option UI'
  );

  await ewTelegramBox.uncheck();
  await ewVkBox.uncheck();
  await ewMaxBox.check();
  await ewPostForm.locator('button.primary[type="submit"]').click();
  await page.locator('#post-form').waitFor({ state: 'detached', timeout: 5000 });

  ewEnabledTargets = db.prepare(`SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1 ORDER BY account_id`)
    .all(ewPost.id).map((row) => row.account_id);
  assert.deepEqual(ewEnabledTargets, [browserPlatformAccounts.max]);
  projectFromApi = (await fixtureApi('GET', '/api/projects')).find((project) => project.id === ew4005Project.id);
  assert.equal(projectFromApi.default_timezone, 'Europe/Moscow');
  assert.deepEqual(
    [...projectFromApi.defaultTargetAccountIds].sort(),
    [editorAccountId, browserPlatformAccounts.vk].sort()
  );

  // Re-open to prove the editor hydrates actual per-post state rather than project defaults.
  await contentRow(ewInheritedTitle).locator('.open-post').click();
  ewInspector = page.locator('.editorial-inspector-overlay');
  await ewInspector.waitFor({ state: 'visible', timeout: 5000 });
  await ewInspector.locator('.inspector-edit').click();
  await ewInspector.waitFor({ state: 'detached', timeout: 5000 });
  ewPostForm = page.locator('#post-form');
  await ewPostForm.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await ewPostForm.locator(`input[name="accountId"][value="${editorAccountId}"]`).isChecked(), false);
  assert.equal(await ewPostForm.locator(`input[name="accountId"][value="${browserPlatformAccounts.vk}"]`).isChecked(), false);
  assert.equal(await ewPostForm.locator(`input[name="accountId"][value="${browserPlatformAccounts.max}"]`).isChecked(), true);
  await ewPostForm.locator('#close-modal').click();
  await page.locator('#post-form').waitFor({ state: 'detached', timeout: 5000 });

  await page.locator('#new-post').click();
  let postForm = page.locator('#post-form');
  await postForm.waitFor({ state: 'visible' });
  const newPostModal = postForm.locator('xpath=ancestor::div[contains(@class,"modal-card")]');
  assert.equal((await newPostModal.locator('h2').textContent())?.trim(), 'Новая публикация');
  const newSections = await newPostModal.locator('.ui-editor-section-title strong').allTextContents();
  assert.ok(newSections.includes('Основное'));
  assert.ok(newSections.includes('После сохранения'));
  assert.match((await postForm.locator('label:has(select[name="scheduleMode"])').innerText()).trim(), /^Когда публиковать/);
  const scheduledLabel = postForm.locator('label:has(input[name="scheduledAt"])');
  assert.match((await scheduledLabel.innerText()).trim(), /^Дата и время публикации/);
  assert.equal(await postForm.locator('select[name="scheduleMode"]').inputValue(), 'MANUAL');
  assert.equal(await scheduledLabel.isHidden(), true);
  await postForm.locator('select[name="scheduleMode"]').selectOption('AT');
  assert.equal(await scheduledLabel.isVisible(), true);
  await postForm.locator('select[name="scheduleMode"]').selectOption('QUEUE');
  assert.equal(await scheduledLabel.isHidden(), true);

  // EW4-003: real Base rich-text create flow.
  const richEditorTitle = 'Browser Canonical Rich Text';
  await postForm.locator('select[name="projectId"]').selectOption(fixtureProjectId);
  await postForm.locator('select[name="scheduleMode"]').selectOption('MANUAL');
  await postForm.locator('input[name="title"]').fill(richEditorTitle);
  assert.equal(await postForm.locator('textarea[name="body"]:visible').count(), 0, 'visible raw body textarea must be absent');
  assert.equal(await postForm.locator('textarea[name="body"][hidden]').count(), 1, 'hidden synchronized plain fallback must remain');
  const richSurface = postForm.locator('[data-rich-text-editor] .rich-text-surface');
  await richSurface.waitFor({ state: 'visible' });
  assert.equal(await postForm.locator('[data-rich-text-editor] .rich-text-toolbar button').count(), 12, 'rich toolbar command count');
  for (const label of ['Жирный','Курсив','Подчёркнутый','Зачёркнутый','Inline code','Ссылка','Цитата','Маркированный список','Нумерованный список','Блок кода','Перенос строки','Вставить emoji']) {
    assert.equal(await postForm.locator(`[data-rich-text-editor] [aria-label="${label}"]`).count(), 1, `missing rich toolbar label: ${label}`);
  }

  await richSurface.click();
  await page.keyboard.type('Normal Bold Italic Underline Strike Code Link');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Quote text');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Bullet text');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Number text');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Code block text');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Emoji: ');

  await richCommand('Bold','bold');
  await richCommand('Italic','italic');
  await richCommand('Underline','underline');
  await richCommand('Strike','strike');
  await richCommand('Code','code');
  await richCommand('Link','link','https://example.test/browser-rich');
  await richCommand('Quote text','quote');
  await richCommand('Bullet text','bullet');
  await richCommand('Number text','ordered');
  await richCommand('Code block text','codeblock');

  await page.evaluate(() => {
    const surface = document.querySelector('[data-rich-text-editor] .rich-text-surface');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(surface);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await postForm.locator('[data-rich-text-editor] [data-rich-command="emoji"]').click();
  await postForm.locator('[data-rich-text-editor] [data-rich-command="break"]').click();
  await page.keyboard.type('After break');

  const editorSnapshot = await page.evaluate(() => {
    const api = document.querySelector('[data-rich-text-editor]')?.richTextEditor;
    return { document: api?.getDocument(), plain: api?.getPlainText() };
  });
  assert.ok(editorSnapshot?.document);
  assert.match(editorSnapshot.plain, /Normal Bold Italic Underline Strike Code/);
  assert.match(editorSnapshot.plain, /🙂/);
  const editorJson = JSON.stringify(editorSnapshot.document);
  for (const type of ['blockquote','bullet_list','ordered_list','code_block']) assert.ok(editorJson.includes(`"type":"${type}"`), `editor AST missing ${type}`);
  for (const mark of ['bold','italic','underline','strike','code']) assert.ok(editorJson.includes(`"type":"${mark}"`), `editor AST missing mark ${mark}`);
  assert.ok(editorJson.includes('"type":"link"'), 'editor AST missing link');

  await postForm.locator('button.primary[type="submit"]').click();
  await page.locator('#post-form').waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForFunction((title) => [...document.querySelectorAll('#view table.table tbody tr')].some((row) => row.textContent?.includes(title)), richEditorTitle);

  const richDbPost = db.prepare('SELECT id,body,body_rich_json,content_version,status,ready_revision_id FROM posts WHERE title=?').get(richEditorTitle);
  assert.ok(richDbPost);
  assert.equal(richDbPost.body, editorSnapshot.plain);
  const storedRich = JSON.parse(richDbPost.body_rich_json);
  assert.deepEqual(storedRich, editorSnapshot.document);
  assert.equal(/<(script|b|strong|em|u|s|a)(\s|>)/i.test(richDbPost.body_rich_json), false, 'canonical storage must be AST JSON, not HTML');

  const richRow = contentRow(richEditorTitle);
  await richRow.locator('.open-post').click();
  let richInspector = page.locator('.editorial-inspector-overlay');
  await richInspector.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await richInspector.locator('[data-inspector-rich-text] strong').count(), 1, 'Content Inspector must render bold from canonical AST');
  assert.equal(await richInspector.locator('[data-inspector-rich-text] a[href^="https://example.test/browser-rich"]').count(), 1, 'Content Inspector must render safe link');
  await richInspector.locator('.inspector-edit').click();
  await richInspector.waitFor({ state: 'detached', timeout: 5000 });

  postForm = page.locator('#post-form');
  await postForm.waitFor({ state: 'visible', timeout: 5000 });
  await postForm.locator('.platform-workspace').waitFor({ state: 'visible', timeout: 5000 });
  for (const selector of ['strong','em','u','s','code','a','blockquote','ul','ol','pre']) {
    assert.ok(await postForm.locator(`[data-rich-text-editor] .rich-text-surface ${selector}`).count() >= 1, `formatting did not hydrate: ${selector}`);
  }

  // EW4-004: one reusable editor, four capability-aware platform cards.
  assert.equal(await postForm.locator('.platform-editor-card').count(), 4, 'EW4-004 requires four platform editor cards');
  const tgCard = postForm.locator('.platform-editor-card[data-platform="telegram"]');
  const maxCard = postForm.locator('.platform-editor-card[data-platform="max"]');
  const vkCard = postForm.locator('.platform-editor-card[data-platform="vk"]');
  const instagramCard = postForm.locator('.platform-editor-card[data-platform="instagram"]');
  for (const card of [tgCard, maxCard, vkCard, instagramCard]) await card.waitFor({ state: 'visible', timeout: 5000 });

  assert.equal(await tgCard.locator('.rich-text-toolbar button').count(), 12, 'Telegram toolbar capability mismatch');
  assert.equal(await maxCard.locator('.rich-text-toolbar button').count(), 12, 'MAX toolbar capability mismatch');
  assert.equal(await vkCard.locator('[data-rich-command="bold"]').count(), 0, 'VK must not advertise bold support');
  assert.equal(await vkCard.locator('[data-rich-command="underline"]').count(), 0, 'VK must not advertise underline support');
  assert.equal(await instagramCard.locator('[data-rich-command="bold"]').count(), 0, 'Instagram must not advertise bold support');
  assert.equal(await instagramCard.locator('[data-rich-command="underline"]').count(), 0, 'Instagram must not advertise underline support');
  assert.equal(await vkCard.locator('[data-rich-command="bullet"]').count(), 1, 'VK list transform missing');
  assert.equal(await instagramCard.locator('[data-rich-command="ordered"]').count(), 1, 'Instagram list transform missing');

  await tgCard.locator('.rich-text-surface').fill('Telegram Browser Bold Link🙂');
  await selectPlatformText('telegram', 'Bold');
  await tgCard.locator('[data-rich-command="bold"]').click();
  await selectPlatformText('telegram', 'Link');
  page.once('dialog', (dialog) => dialog.accept('https://example.test/browser-telegram'));
  await tgCard.locator('[data-rich-command="link"]').click();
  await tgCard.locator('.save-platform-text').click();
  await page.waitForFunction(() => document.querySelector('.platform-editor-card[data-platform="telegram"] .platform-save-state')?.textContent?.includes('TargetRendition'));

  await maxCard.locator('.rich-text-surface').fill('MAX Browser Underline <literal>');
  await selectPlatformText('max', 'Underline');
  await maxCard.locator('[data-rich-command="underline"]').click();
  await maxCard.locator('.save-platform-text').click();
  await page.waitForFunction(() => document.querySelector('.platform-editor-card[data-platform="max"] .platform-save-state')?.textContent?.includes('TargetRendition'));

  // VK/Instagram keep inherited rich Base visible even though their toolbar does not advertise dropped marks.
  await vkCard.locator('.save-platform-text').click();
  await page.waitForFunction(() => document.querySelector('.platform-editor-card[data-platform="vk"] .platform-save-state')?.textContent?.includes('TargetRendition'));
  await instagramCard.locator('.save-platform-text').click();
  await page.waitForFunction(() => document.querySelector('.platform-editor-card[data-platform="instagram"] .platform-save-state')?.textContent?.includes('TargetRendition'));

  const platformOverrideRows = db.prepare(`SELECT a.platform,pt.override_text,tr.text_rich_json,tr.text_plain
    FROM post_targets pt
    JOIN social_accounts a ON a.id=pt.account_id
    LEFT JOIN target_renditions tr ON tr.target_id=pt.id
    WHERE pt.post_id=? ORDER BY a.platform`).all(richDbPost.id);
  assert.equal(platformOverrideRows.length, 4);
  for (const row of platformOverrideRows) {
    assert.equal(row.override_text, null, `${row.platform} new rich save must not use legacy override_text`);
    assert.ok(row.text_rich_json, `${row.platform} rich TargetRendition missing`);
    assert.ok(row.text_plain, `${row.platform} matching text_plain missing`);
  }
  const telegramStoredAst = JSON.parse(platformOverrideRows.find((row) => row.platform === 'telegram').text_rich_json);
  const maxStoredAst = JSON.parse(platformOverrideRows.find((row) => row.platform === 'max').text_rich_json);
  assert.ok(JSON.stringify(telegramStoredAst).includes('"type":"bold"'), 'Telegram editor must persist bold mark in TargetRendition');
  assert.ok(JSON.stringify(telegramStoredAst).includes('"type":"link"'), 'Telegram editor must persist link node in TargetRendition');
  assert.ok(JSON.stringify(maxStoredAst).includes('"type":"underline"'), 'MAX editor must persist underline mark in TargetRendition');

  await postForm.locator('#close-modal').click();
  await page.locator('#post-form').waitFor({ state: 'detached', timeout: 5000 });
  await contentRow(richEditorTitle).locator('.open-post').click();
  richInspector = page.locator('.editorial-inspector-overlay');
  await richInspector.waitFor({ state: 'visible', timeout: 5000 });
  const compilerPreviewSection = richInspector.locator('.platform-preview-section');
  await compilerPreviewSection.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('.platform-preview-section .platform-preview-card').length === 4);
  assert.ok(await compilerPreviewSection.locator('.platform-telegram .platform-preview-caption strong').count() >= 1, 'Telegram preview must preserve bold safely');
  assert.ok(await compilerPreviewSection.locator('.platform-max .platform-preview-caption u').count() >= 1, 'MAX preview must preserve underline safely');
  assert.ok((await compilerPreviewSection.locator('.platform-vk').innerText()).includes('RICH_BOLD_DOWNGRADED'), 'VK downgrade warning missing');
  assert.ok((await compilerPreviewSection.locator('.platform-instagram').innerText()).includes('RICH_UNDERLINE_DOWNGRADED'), 'Instagram downgrade warning missing');
  assert.ok((await compilerPreviewSection.locator('.platform-telegram').innerText()).includes('Свой rich-вариант'));
  assert.ok((await compilerPreviewSection.locator('.platform-max').innerText()).includes('Свой rich-вариант'));

  await richInspector.locator('.inspector-edit').click();
  await richInspector.waitFor({ state: 'detached', timeout: 5000 });
  postForm = page.locator('#post-form');
  await postForm.waitFor({ state: 'visible', timeout: 5000 });
  await postForm.locator('.platform-workspace').waitFor({ state: 'visible', timeout: 5000 });
  assert.ok((await postForm.locator('.platform-editor-card[data-platform="telegram"] .rich-text-surface').innerText()).includes('Telegram Browser Bold Link🙂'));
  assert.ok(await postForm.locator('.platform-editor-card[data-platform="telegram"] .rich-text-surface strong').count() >= 1);
  assert.ok(await postForm.locator('.platform-editor-card[data-platform="telegram"] .rich-text-surface a[href^="https://example.test/browser-telegram"]').count() >= 1);
  assert.ok(await postForm.locator('.platform-editor-card[data-platform="max"] .rich-text-surface u').count() >= 1);
  assert.ok(await postForm.locator('.platform-editor-card[data-platform="vk"] .rich-text-surface strong').count() >= 1, 'unsupported inherited Base formatting must remain visible in VK editor');
  assert.ok(await postForm.locator('.platform-editor-card[data-platform="instagram"] .rich-text-surface strong').count() >= 1, 'unsupported inherited Base formatting must remain visible in Instagram editor');

  const previewText = await postForm.locator('.platform-preview-text').first().innerText();
  assert.ok(previewText.includes('Normal Bold Italic Underline Strike Code'), 'platform preview must use rich editor plain fallback');
  assert.ok(!previewText.includes('**'), 'platform preview must not invent Markdown');

  await postForm.locator('#media-file').setInputFiles(richEditorImagePath);
  await page.waitForFunction(() =>
    document.querySelector('#post-form .media-list img') !== null
    || document.querySelector('.editorial-inspector-overlay .inspector-media-host img') !== null
  );
  const uploadInspector = page.locator('.editorial-inspector-overlay');
  if (await uploadInspector.count()) {
    await uploadInspector.locator('.inspector-edit').click();
    await uploadInspector.waitFor({ state: 'detached', timeout: 5000 });
  }
  postForm = page.locator('#post-form');
  await postForm.waitFor({ state: 'visible', timeout: 5000 });
  await postForm.locator('.media-list img').first().waitFor({ state: 'visible', timeout: 5000 });
  await postForm.locator('#mark-ready').click();
  await page.locator('#post-form').waitFor({ state: 'detached', timeout: 5000 });

  const richReadyState = db.prepare('SELECT content_version,status,editorial_stage,ready_revision_id FROM posts WHERE id=?').get(richDbPost.id);
  assert.equal(richReadyState.status, 'READY');
  assert.equal(richReadyState.editorial_stage, 'APPROVED');
  assert.ok(richReadyState.ready_revision_id);
  const richReadyRevision = db.prepare('SELECT id,body,body_rich_json,editorial_stage FROM content_revisions WHERE id=?').get(richReadyState.ready_revision_id);
  assert.equal(richReadyRevision.editorial_stage, 'APPROVED');
  assert.equal(richReadyRevision.body, editorSnapshot.plain);
  assert.deepEqual(JSON.parse(richReadyRevision.body_rich_json), editorSnapshot.document);

  await contentRow(richEditorTitle).locator('.open-post').click();
  richInspector = page.locator('.editorial-inspector-overlay');
  await richInspector.waitFor({ state: 'visible', timeout: 5000 });
  await richInspector.locator('.inspector-edit').click();
  postForm = page.locator('#post-form');
  await postForm.waitFor({ state: 'visible', timeout: 5000 });
  const changedSurface = postForm.locator('[data-rich-text-editor] .rich-text-surface');
  await changedSurface.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('Changed after READY');
  await richCommand('READY','bold');
  await postForm.locator('button.primary[type="submit"]').click();
  await page.locator('#post-form').waitFor({ state: 'detached', timeout: 5000 });

  const changedState = db.prepare('SELECT content_version,status,editorial_stage,ready_revision_id FROM posts WHERE id=?').get(richDbPost.id);
  assert.equal(changedState.status,'DRAFT');
  assert.equal(changedState.editorial_stage,'DRAFT');
  assert.equal(changedState.ready_revision_id,null);
  assert.ok(changedState.content_version > richReadyState.content_version);

  await contentRow(richEditorTitle).locator('.open-post').click();
  richInspector = page.locator('.editorial-inspector-overlay');
  await richInspector.waitFor({ state: 'visible', timeout: 5000 });
  await richInspector.locator('.inspector-history').click();
  const richHistoryOverlay = page.locator('.revision-history-overlay');
  await richHistoryOverlay.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForFunction((revisionId) => document.querySelector(`.revision-history-item[data-revision-id="${revisionId}"]`) !== null, richReadyState.ready_revision_id);
  await richHistoryOverlay.locator(`.revision-history-item[data-revision-id="${richReadyState.ready_revision_id}"]`).click();
  const richHistoryDetail = richHistoryOverlay.locator('.revision-detail');
  await richHistoryDetail.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await richHistoryDetail.locator('.revision-rich-preview strong').count(), 1, 'History formatted preview must render canonical marks');
  assert.equal(await richHistoryDetail.locator('.revision-restore').count(),1);
  page.once('dialog',(dialog)=>dialog.accept());
  await richHistoryDetail.locator('.revision-restore').click();
  await richHistoryOverlay.waitFor({ state: 'detached', timeout: 5000 });

  richInspector = page.locator('.editorial-inspector-overlay');
  await richInspector.waitFor({ state: 'visible', timeout: 5000 });
  const restoredRichView = await fixtureApi('GET', `/api/posts/${richDbPost.id}`);
  assert.ok(restoredRichView.content_version > changedState.content_version);
  assert.equal(restoredRichView.status,'DRAFT');
  assert.equal(restoredRichView.editorial_stage,'DRAFT');
  assert.equal(restoredRichView.ready_revision_id,null);
  assert.equal(restoredRichView.body,editorSnapshot.plain);
  assert.deepEqual(restoredRichView.bodyRich,editorSnapshot.document);

  await richInspector.locator('.inspector-edit').click();
  postForm = page.locator('#post-form');
  await postForm.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await postForm.locator('[data-rich-text-editor] .rich-text-surface strong').count(),1,'restored editor must hydrate formatting');

  // Hostile clipboard HTML is treated as plain text; executable DOM never enters the editor/storage.
  await page.evaluate(() => {
    const surface=document.querySelector('[data-rich-text-editor] .rich-text-surface');
    surface.focus();
    const selection=window.getSelection();
    const range=document.createRange();
    range.selectNodeContents(surface);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    const data=new DataTransfer();
    data.setData('text/html','<img src=x onerror="window.__richXss=1"><script>window.__richXss=2</script>');
    data.setData('text/plain','<script>literal</script> <img onerror=literal>');
    surface.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  });
  assert.equal(await postForm.locator('[data-rich-text-editor] .rich-text-surface script,[data-rich-text-editor] .rich-text-surface img').count(),0,'hostile clipboard must not create executable elements');
  assert.equal(await page.evaluate(()=>window.__richXss||0),0);
  await postForm.locator('button.primary[type="submit"]').click();
  await page.locator('#post-form').waitFor({ state: 'detached', timeout: 5000 });
  const xssStored=db.prepare('SELECT content_version,body_rich_json FROM posts WHERE id=?').get(richDbPost.id);
  const xssAst=JSON.parse(xssStored.body_rich_json);
  const unsafeKeys=[];
  const walk=(value)=>{
    if(Array.isArray(value)){value.forEach(walk);return;}
    if(!value||typeof value!=='object')return;
    for(const key of Object.keys(value)){
      if(/^on/i.test(key)||['innerHTML','style','class'].includes(key))unsafeKeys.push(key);
      walk(value[key]);
    }
  };
  walk(xssAst);
  assert.deepEqual(unsafeKeys,[]);
  assert.equal(JSON.stringify(xssAst).includes('"type":"script"'),false);

  const xssVersion=xssStored.content_version;
  const unsafeLinkResponse=await app.inject({
    method:'PATCH',
    url:`/api/posts/${richDbPost.id}`,
    headers:{cookie:fixtureCookie},
    payload:{
      expectedContentVersion:xssVersion,
      bodyRich:{type:'doc',content:[{type:'paragraph',content:[
        {type:'link',attrs:{href:'javascript:alert(1)'},content:[{type:'text',text:'bad',marks:[]}]}
      ]}]}
    }
  });
  assert.equal(unsafeLinkResponse.statusCode,400,unsafeLinkResponse.body);
  assert.equal(db.prepare('SELECT content_version FROM posts WHERE id=?').get(richDbPost.id).content_version,xssVersion);

  // Same final fixture: Preview API compiler result must equal publisher compiler input.
  const finalReady = await fixtureApi('POST', `/api/posts/${richDbPost.id}/ready`, { expectedContentVersion: xssVersion });
  assert.ok(finalReady.revisionId);
  const parityPreviews = await fixtureApi('GET', `/api/posts/${richDbPost.id}/platform-previews`);
  assert.equal(parityPreviews.previews.length, 4);
  const publisherCaptures = {};
  for (const platform of ['telegram','max','vk','instagram']) {
    setPublisherForTests(platform, {
      platform,
      validate(input) { assert.ok(input.textCompilation, `${platform} browser parity compilation missing`); },
      async publish(input) {
        publisherCaptures[platform] = input;
        return { externalId: `browser-${platform}`, externalUrl: `https://example.test/browser-${platform}` };
      }
    });
  }
  try {
    await publishPost(richDbPost.id);
  } finally {
    for (const platform of ['telegram','max','vk','instagram']) setPublisherForTests(platform, null);
  }
  assert.deepEqual(Object.keys(publisherCaptures).sort(), ['instagram','max','telegram','vk']);
  for (const preview of parityPreviews.previews) {
    const published = publisherCaptures[preview.platform];
    assert.ok(published, `publisher capture missing for ${preview.platform}`);
    assert.deepEqual(published.textCompilation, preview.compilation, `preview/publisher compiler parity failed for ${preview.platform}`);
    assert.equal(published.text, preview.compilation.plainText, `publisher plain mismatch for ${preview.platform}`);
  }
  assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(richDbPost.id).status, 'PUBLISHED');

  await draftRow.locator('.open-post').click();
  const contentInspector = page.locator('.editorial-inspector-overlay');
  await contentInspector.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await contentInspector.locator('.inspector-edit').count(), 1, 'Content Inspector edit action missing');
  await contentInspector.locator('.inspector-edit').click();
  await contentInspector.waitFor({ state: 'detached', timeout: 5000 });

  postForm = page.locator('#post-form');
  await postForm.waitFor({ state: 'visible', timeout: 5000 });
  const existingPostModal = postForm.locator('xpath=ancestor::div[contains(@class,"modal-card")]');
  await existingPostModal.locator('.platform-workspace').waitFor({ state: 'visible', timeout: 5000 });
  const existingSections = await existingPostModal.locator('.ui-editor-section-title strong').allTextContents();
  for (const section of ['Основное', 'Медиа', 'Площадки']) assert.ok(existingSections.includes(section), `existing editor section missing: ${section}`);
  assert.equal(await postForm.locator('#media-file').count(), 1, 'existing editor media enhancement missing');
  assert.equal(await existingPostModal.locator('.platform-editor-card').count(), 4, 'existing editor target enhancement missing');
  await postForm.locator('#close-modal').click();
  await page.locator('#post-form').waitFor({ state: 'detached', timeout: 5000 });

  const revisionRow = contentRow(revisionHistoryTitle);
  assert.equal(await revisionRow.count(), 1, 'Revision History browser fixture must render once');
  await revisionRow.locator('.open-post').click();
  let revisionInspector = page.locator('.editorial-inspector-overlay');
  await revisionInspector.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal((await revisionInspector.locator('.inspector-history').textContent())?.trim(), 'История изменений');
  await revisionInspector.locator('.inspector-history').click();

  let historyOverlay = page.locator('.revision-history-overlay');
  await historyOverlay.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal((await historyOverlay.locator('h2').textContent())?.trim(), 'История изменений');
  await page.waitForFunction(() => document.querySelectorAll('.revision-history-overlay .revision-history-item').length === 3);
  assert.equal(await historyOverlay.locator('.revision-history-item').count(), 3);
  await historyOverlay.locator('.revision-history-item').filter({ hasText: 'Версия 1' }).click();
  const revisionDetail = historyOverlay.locator('.revision-detail');
  await revisionDetail.waitFor({ state: 'visible', timeout: 5000 });
  const detailText = await revisionDetail.innerText();
  for (const expected of ['Текст', 'Публикация', 'Площадки', 'Медиа', 'Revision body A', 'Revision body B', 'Вручную', 'По времени', 'Revision target override']) {
    assert.ok(detailText.includes(expected), `Revision History detail missing: ${expected}`);
  }
  assert.equal(await revisionDetail.locator('.revision-restore').count(), 1, 'safe historical revision must expose Restore');
  page.once('dialog', (dialog) => dialog.accept());
  await revisionDetail.locator('.revision-restore').click();
  await historyOverlay.waitFor({ state: 'detached', timeout: 5000 });

  revisionInspector = page.locator('.editorial-inspector-overlay');
  await revisionInspector.waitFor({ state: 'visible', timeout: 5000 });
  const restoredView = await fixtureApi('GET', `/api/posts/${revisionPost.id}`);
  assert.equal(restoredView.content_version, 4);
  assert.equal(restoredView.body, 'Revision body A');
  assert.equal(restoredView.status, 'DRAFT');
  assert.equal(restoredView.editorial_stage, 'DRAFT');
  assert.equal(restoredView.ready_revision_id, null);
  const restoredRevisionRow = db.prepare('SELECT content_version,actor_source,restored_from_revision_id FROM content_revisions WHERE post_id=? ORDER BY content_version DESC LIMIT 1').get(revisionPost.id);
  assert.deepEqual(restoredRevisionRow, {
    content_version: 4,
    actor_source: 'manual_restore',
    restored_from_revision_id: revisionV1.id
  });

  await revisionInspector.locator('.inspector-history').click();
  historyOverlay = page.locator('.revision-history-overlay');
  await historyOverlay.waitFor({ state: 'visible', timeout: 5000 });
  const newestHistory = historyOverlay.locator('.revision-history-item').first();
  assert.match((await newestHistory.innerText()), /Версия 4/);
  assert.match((await newestHistory.innerText()), /восстановлена из версии 1/);
  await historyOverlay.locator('.revision-history-close').click();
  await historyOverlay.waitFor({ state: 'detached', timeout: 5000 });
  await revisionInspector.locator('.inspector-close').click();
  await revisionInspector.waitFor({ state: 'detached', timeout: 5000 });

  await page.goto(`${base}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent?.trim() === 'Календарь');
  await page.locator('.calendar-shell').waitFor({ state: 'visible' });
  assert.equal((await page.locator('[data-calendar-mode="agenda"]').textContent())?.trim(), 'Список');
  assert.match((await page.locator('.calendar-toolbar').innerText()), /Часовой пояс:/);
  let calendarFixtureCard = page.locator(`[data-calendar-post="${calendarFixture.id}"]`);
  await calendarFixtureCard.waitFor({ state: 'visible' });
  let calendarFixtureText = await calendarFixtureCard.innerText();
  assert.ok(calendarFixtureText.includes('Google Sheets'));
  assert.ok(calendarFixtureText.includes('Готово'));
  assert.equal(await calendarFixtureCard.locator('[data-raw-status="READY"]').count(), 1);
  for (const raw of ['google_sheets', 'READY', 'schedule', 'display', 'Agenda']) assert.ok(!calendarFixtureText.includes(raw), `Calendar exposes technical presentation: ${raw}`);

  await page.locator('[data-calendar-mode="agenda"]').click();
  await page.waitForFunction((id) => document.querySelector(`.calendar-list-card[data-calendar-post="${id}"]`) !== null, calendarFixture.id);
  calendarFixtureCard = page.locator(`.calendar-list-card[data-calendar-post="${calendarFixture.id}"]`);
  calendarFixtureText = await calendarFixtureCard.innerText();
  for (const expected of ['Google Sheets', 'На проверке', 'Готово']) assert.ok(calendarFixtureText.includes(expected), `Calendar list presentation missing: ${expected}`);
  assert.equal(await calendarFixtureCard.locator('[data-raw-status="IN_REVIEW"]').count(), 1);
  assert.equal(await calendarFixtureCard.locator('[data-raw-status="READY"]').count(), 1);
  for (const raw of ['google_sheets', 'IN_REVIEW', 'READY', 'schedule', 'display', 'Agenda']) assert.ok(!calendarFixtureText.includes(raw), `Calendar list exposes technical presentation: ${raw}`);

  await page.locator('[data-calendar-mode="month"]').click();
  await page.waitForFunction((id) => document.querySelector(`.calendar-card[data-calendar-post="${id}"]`) !== null, calendarFixture.id);
  calendarFixtureCard = page.locator(`.calendar-card[data-calendar-post="${calendarFixture.id}"]`);
  assert.ok((await calendarFixtureCard.innerText()).includes('Google Sheets'), 'Calendar presentation must survive mode rerender');

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
    contentPresentationOwnership: true,
    postEditorScaffoldOwnership: true,
    calendarPresentationOwnership: true,
    legacyPagePolishRemoved: true,
    revisionHistoryUx: true,
    canonicalRichTextEditor: true,
    richTextPersistence: true,
    richTextRevisionRoundtrip: true,
    richTextXssSafe: true,
    platformRichTextEditors: true,
    telegramEntityCompiler: true,
    maxFormattingCompiler: true,
    vkRichTextDowngrade: true,
    instagramRichTextDowngrade: true,
    compilerPreviewParity: true,
    compilerPublisherParity: true,
    noBodyOverflow: true,
    pageErrors: 0
  }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
