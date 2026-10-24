import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-preview-lifecycle-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  ADMIN_PASSWORD: 'preview-lifecycle-test-password',
  APP_MASTER_KEY: 'preview-lifecycle-test-master-key-longer-than-thirty-two-characters',
  PUBLIC_BASE_URL: 'http://127.0.0.1:18109'
});

const { db, migrate, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');

migrate();
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const now = nowIso();
for (const [platform, accountId, credentials] of [
  ['telegram', 'acc_preview_tg', { botToken: 'fixture', chatId: '@test' }],
  ['max', 'acc_preview_max', { accessToken: 'fixture', chatId: '-100777' }]
]) {
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`)
    .run(accountId, platform, platform + ' preview', encryptJson(credentials), now, now);
  db.prepare('INSERT INTO project_default_targets (project_id,account_id,created_at) VALUES (?,?,?)')
    .run(projectId, accountId, now);
}

const app = await buildApp();
let browser;
try {
  await app.ready();
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { password: process.env.ADMIN_PASSWORD }
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const posts = [];
  for (const title of ['Delayed preview inspector', 'Second preview inspector']) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { cookie },
      payload: {
        projectId, title, body: 'Ordinary preview test text',
        scheduleMode: 'MANUAL', contentFormat: 'TEXT_ONLY'
      }
    });
    assert.equal(created.statusCode, 201, created.body);
    posts.push(created.json());
  }
  assert.ok(posts.every(x => typeof x.id === 'string'));

  await app.listen({ host: '127.0.0.1', port: 18109 });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  const previewCalls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/platform-previews')) previewCalls.push(request.url());
  });

  // Deliberately make the inspector API slower than the deleted 1500ms timer.
  const slowInspectorPath = new RegExp('/api/editorial/posts/' + posts[0].id + '(?:\\?|$)');
  let slowRequestCount = 0;
  await page.route(slowInspectorPath, async route => {
    slowRequestCount++;
    await new Promise(resolve => setTimeout(resolve, 1900));
    await route.continue();
  });

  await page.goto('http://127.0.0.1:18109/content', { waitUntil: 'domcontentloaded' });
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  const contentRow = title => page.getByRole('row').filter({ hasText: title });

  await contentRow('Delayed preview inspector').getByRole('button', { name: 'Открыть', exact: true }).click();
  let overlay = page.locator('.editorial-inspector-overlay');
  await overlay.waitFor({ state: 'visible', timeout: 9000 });
  let previews = overlay.locator('.platform-preview-section');
  await previews.waitFor({ state: 'visible', timeout: 5000 });
  await previews.locator('.platform-preview-card').first().waitFor({ state: 'visible' });
  assert.equal(await previews.locator('.platform-preview-card').count(), 2);
  assert.equal(slowRequestCount, 1, 'the 1900ms delayed inspector GET must be intercepted');
  assert.ok(previewCalls.some(url => url.includes(posts[0].id)), 'previews must request opened post ID');

  await overlay.locator('.inspector-close').click();
  await overlay.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.platform-preview-section').count(), 0, 'close cleans preview host');

  // Subsequent opens must use the NEW post ID, not a stale click/timeout value.
  await contentRow('Second preview inspector').getByRole('button', { name: 'Открыть', exact: true }).click();
  overlay = page.locator('.editorial-inspector-overlay');
  await overlay.waitFor({ state: 'visible', timeout: 6000 });
  await overlay.locator('.platform-preview-section .platform-preview-card').first().waitFor({ state: 'visible' });
  assert.equal(await overlay.locator('.platform-preview-section .platform-preview-card').count(), 2);
  assert.ok(previewCalls.some(url => url.includes(posts[1].id)), 'second inspector must request second post ID');
  await overlay.locator('.inspector-close').click();
  await overlay.waitFor({ state: 'detached' });

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({
    ok: true, checkpoint: 'CX3-PREVIEW-RACE-001',
    slowInspectorDelayMs: 1900, interceptedSlowRequest: slowRequestCount === 1,
    previewCards: 2, correctPostAfterReopen: true, cleanupOnClose: true, browserErrors: 0
  }));
} finally {
  await browser?.close();
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
