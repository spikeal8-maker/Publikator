import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-text-browser-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: dataDir, ADMIN_PASSWORD: 'vk-text-browser-password',
  APP_MASTER_KEY: 'vk-text-browser-master-key-longer-than-thirty-two-characters', PUBLIC_BASE_URL: 'http://127.0.0.1:18094' });
const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();
const originalFetch = globalThis.fetch;
let wallWrites = 0;
globalThis.fetch = async (input, init = {}) => {
  const method = /\/method\/([^/?]+)/.exec(String(input))?.[1];
  const params = new URLSearchParams(String(init.body || ''));
  if (method === 'groups.getTokenPermissions') return Response.json({ response: { permissions: [{ name: 'wall' }] } });
  if (method === 'groups.getById') {
    assert.equal(params.has('group_id'), false);
    return Response.json({ response: { groups: [{ id: 67890, name: 'Browser community', screen_name: 'club67890' }] } });
  }
  if (method === 'wall.post') {
    wallWrites += 1;
    assert.equal(params.get('owner_id'), '-67890');
    assert.equal(params.get('attachments'), '');
    return Response.json({ response: { post_id: 7654 } });
  }
  throw new Error('Unexpected provider method ' + method);
};
let browser;
try {
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const saved = await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: {
    platform: 'vk', name: 'Browser GROUP', credentials: { authKind: 'COMMUNITY', destinationKind: 'COMMUNITY',
      groupId: '67890', accessToken: 'browser-group-fixture-secret' }
  } });
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(wallWrites, 0);
  await app.listen({ host: '127.0.0.1', port: 18094 });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('http://127.0.0.1:18094/content');
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#new-post').waitFor({ state: 'visible' });
  async function create(title, format) {
    await page.locator('#new-post').click();
    const form = page.locator('#post-form');
    await form.locator('input[name="title"]').fill(title);
    await form.locator('[contenteditable="true"]').first().fill('Text through the ordinary operator form');
    await form.locator('select[name="postFormat"]').selectOption(format);
    await form.locator('button[type="submit"]').click();
    await form.waitFor({ state: 'detached' });
    const row = db.prepare('SELECT * FROM posts WHERE title=?').get(title);
    assert.ok(row);
    return row;
  }
  async function edit(title) {
    await page.getByRole('row').filter({ hasText: title }).getByRole('button', { name: 'Открыть', exact: true }).click();
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page.locator('.platform-editor-card').waitFor({ state: 'visible' });
    return page.locator('#post-form');
  }
  const text = await create('VK browser text', 'TEXT_ONLY');
  assert.equal(text.content_format, 'TEXT_ONLY');
  let form = await edit(text.title);
  assert.equal(await form.locator('select[name="postFormat"]').inputValue(), 'TEXT_ONLY');
  assert.match(await form.textContent(), /Только текст.*без вложений/);
  assert.doesNotMatch(await form.textContent(), /без него READY запрещён/);
  await form.locator('#mark-ready').click();
  await form.waitFor({ state: 'detached' });
  assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(text.id).status, 'READY');
  assert.equal(wallWrites, 0);
  form = await edit(text.title);
  await form.locator('#publish-now').click();
  await form.waitFor({ state: 'detached' });
  assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(text.id).status, 'PUBLISHED');
  assert.equal(wallWrites, 1);

  const image = await create('VK browser image limit', 'MEDIA');
  form = await edit(image.title);
  const imagePath = path.join(dataDir, 'image.jpg');
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#123456' } }).jpeg().toFile(imagePath);
  await form.locator('#media-file').setInputFiles(imagePath);
  await page.waitForFunction(() => document.querySelector('#post-form .media-list img'));
  await page.locator('.platform-editor-card').waitFor({ state: 'visible' });
  form = page.locator('#post-form');
  await form.locator('#mark-ready').click();
  await page.locator('#post-error').getByText(/пользовательский ключ/).waitFor();
  assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(image.id).status, 'DRAFT');
  assert.equal(wallWrites, 1, 'photo preflight must not publish');
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  console.log(JSON.stringify({ ok: true, checkpoint: 'VK-GROUP-TEXT-001-BROWSER',
    formatSelection: true, ordinaryCreateReadyPublish: true, photoLimitBeforePublicWrite: true, pageErrors: 0 }));
} finally {
  await browser?.close();
  globalThis.fetch = originalFetch;
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
