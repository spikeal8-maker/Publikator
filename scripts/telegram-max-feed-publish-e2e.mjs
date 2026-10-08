import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-tg-max-feed-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: dataDir, ADMIN_PASSWORD: 'tg-max-browser-password',
  APP_MASTER_KEY: 'tg-max-test-master-key-longer-than-thirty-two-characters', PUBLIC_BASE_URL: 'http://127.0.0.1:18096' });
const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
const { decryptJson } = await import('../dist/crypto.js');
const { maxPublisher } = await import('../dist/platforms/max.js');
const { telegramPublisher } = await import('../dist/platforms/telegram.js');
const { compilePlatformText } = await import('../dist/platform-text.js');
migrate();
const app = await buildApp();
const originalFetch = globalThis.fetch;
const calls = [];
let nextImage = 0;
let nextMessage = 500;
let uploadMode = 'ok';
let messageMode = 'ok';
const tgSecret = 'fixture-telegram-bot-secret';
const maxSecret = 'fixture-max-bot-secret';

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = url.pathname.split('/').pop();
  calls.push({ host: url.hostname, method, init });
  if (url.hostname === 'api.telegram.org') {
    assert.ok(url.pathname.startsWith('/bot' + tgSecret + '/'));
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 321, username: 'fixture_bot' } });
    if (method === 'getChat') return Response.json({ ok: true, result: { id: -100654, type: 'channel', title: 'Fixture Telegram', username: 'fixture_channel' } });
    if (method === 'getChatMember') return Response.json({ ok: true, result: { status: 'administrator', can_post_messages: true } });
    if (method === 'sendMessage') {
      const body = JSON.parse(init.body);
      assert.equal(body.chat_id, '@fixture_channel');
      assert.ok(body.text.trim());
      assert.equal(body.parse_mode, undefined);
      return Response.json({ ok: true, result: { message_id: ++nextMessage, chat: { id: -100654, username: 'fixture_channel' } } });
    }
    if (method === 'sendPhoto') {
      assert.ok(init.body instanceof FormData);
      assert.ok(init.body.get('photo') instanceof Blob);
      return Response.json({ ok: true, result: { message_id: ++nextMessage, chat: { id: -100654, username: 'fixture_channel' } } });
    }
    throw new Error('Unexpected Telegram method ' + method);
  }
  if (url.hostname === 'platform-api2.max.ru') {
    assert.equal(init.headers.Authorization, maxSecret);
    if (url.pathname === '/me') return Response.json({ user_id: 432, username: 'fixture_max_bot' });
    if (url.pathname.endsWith('/members/me')) return Response.json({ is_admin: true, permissions: ['write'] });
    if (url.pathname === '/uploads') {
      assert.equal(url.searchParams.get('type'), 'image');
      if (uploadMode === 'reserve-503') return Response.json({ code: 'internal.error' }, { status: 503 });
      if (uploadMode === 'host') return Response.json({ url: 'https://127.0.0.1/uploadImage' });
      return Response.json({ url: 'https://iu.oneme.ru/uploadImage?photoIds=' + (++nextImage) });
    }
    if (url.pathname === '/messages') {
      assert.equal(url.searchParams.get('chat_id'), '-100777');
      const body = JSON.parse(init.body);
      assert.equal(body.format, 'html');
      for (const attachment of body.attachments) {
        assert.equal(attachment.type, 'image');
        assert.match(attachment.payload.token, /^fixture-image-/);
        assert.equal(attachment.payload.url, undefined);
      }
      if (messageMode === 'not-ready') return Response.json({ code: 'attachment.not.ready' }, { status: 400 });
      if (messageMode === 'network') throw new TypeError('response lost after public POST');
      if (messageMode === 'missing-id') return Response.json({ message: { body: {} } });
      return Response.json({ message: { body: { mid: String(++nextMessage) }, link: 'https://max.ru/fixture/' + nextMessage } });
    }
  }
  if (url.hostname === 'iu.oneme.ru') {
    assert.equal(init.headers?.Authorization, undefined, 'bot secret must not be sent to the upload host');
    assert.equal(init.redirect, 'error');
    assert.ok(init.body instanceof FormData);
    const file = init.body.get('data');
    assert.ok(file instanceof Blob && file.size > 0);
    if (uploadMode === 'binary-503') return Response.json({ code: 'internal.error' }, { status: 503 });
    if (uploadMode === 'missing-token') return Response.json({ photos: {} });
    return Response.json({ photos: { [url.searchParams.get('photoIds')]: { token: 'fixture-image-' + url.searchParams.get('photoIds') } } });
  }
  throw new Error('Unexpected provider host ' + url.hostname);
};

const writes = () => calls.filter(c => ['sendMessage', 'sendPhoto', 'messages'].includes(c.method)).length;
let browser;
try {
  await app.ready();
  await app.listen({ host: '127.0.0.1', port: 18096 });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:18096/socials');
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  for (const [platform, secret, destination] of [['telegram', tgSecret, '@fixture_channel'], ['max', maxSecret, '-100777']]) {
    await page.locator('.operator-add-platform[data-platform="' + platform + '"]').click();
    const form = page.locator('#operator-social-form');
    await form.locator('input[name="name"]').fill('Browser ' + platform);
    await form.locator('input[name="' + (platform === 'telegram' ? 'botToken' : 'accessToken') + '"]').fill(secret);
    await form.locator('input[name="chatId"]').fill(destination);
    await form.locator('#operator-test-connect').click();
    await page.waitForFunction(() => document.querySelector('#operator-save-connect')?.disabled === false);
    await form.locator('#operator-save-connect').click();
    await form.waitFor({ state: 'detached' });
    const account = db.prepare('SELECT * FROM social_accounts WHERE name=?').get('Browser ' + platform);
    assert.equal(account.enabled, 1);
    assert.ok(account.credentials_encrypted.startsWith('v1:'));
    const stored = decryptJson(account.credentials_encrypted);
    assert.equal(stored[platform === 'telegram' ? 'botToken' : 'accessToken'], secret);
    assert.equal(stored.chatId, destination);
  }
  assert.equal(writes(), 0, 'inspection/save must not publish');
  const cookie = (await page.context().cookies()).map(c => c.name + '=' + c.value).join('; ');
  const accounts = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie } });
  assert.equal(accounts.body.includes(tgSecret), false);
  assert.equal(accounts.body.includes(maxSecret), false);

  const imagePath = path.join(dataDir, 'fixture.jpg');
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#225588' } }).jpeg().toFile(imagePath);
  async function edit(title) {
    await page.getByRole('row').filter({ hasText: title }).getByRole('button', { name: 'Открыть', exact: true }).click();
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page.locator('.platform-editor-card').waitFor({ state: 'visible' });
    return page.locator('#post-form');
  }
  for (const [title, format] of [['Browser text', 'TEXT_ONLY'], ['Browser image', 'MEDIA']]) {
    await page.goto('http://127.0.0.1:18096/content');
    await page.locator('#new-post').click();
    let form = page.locator('#post-form');
    await form.locator('input[name="title"]').fill(title);
    await form.locator('[contenteditable="true"]').first().fill('Тест полного пути Telegram и MAX');
    await form.locator('select[name="postFormat"]').selectOption(format);
    await form.locator('button[type="submit"]').click();
    await form.waitFor({ state: 'detached' });
    form = await edit(title);
    if (format === 'MEDIA') {
      await form.locator('#media-file').setInputFiles(imagePath);
      await form.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
      await page.locator('#post-form .media-list img').waitFor({ state: 'visible' });
      form = page.locator('#post-form');
    }
    const before = writes();
    await form.locator('#mark-ready').click();
    await form.waitFor({ state: 'detached' });
    const post = db.prepare('SELECT * FROM posts WHERE title=?').get(title);
    assert.equal(post.status, 'READY');
    assert.equal(writes(), before, 'READY must not publish');
    form = await edit(title);
    await form.locator('#publish-now').click();
    await form.waitFor({ state: 'detached' });
    assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(post.id).status, 'PUBLISHED');
    const targets = db.prepare('SELECT * FROM post_targets WHERE post_id=? AND enabled=1').all(post.id);
    assert.equal(targets.length, 2);
    assert.ok(targets.every(t => t.state === 'PUBLISHED' && t.external_id));
    assert.equal(writes(), before + 2);
  }
  const media = db.prepare('SELECT * FROM media ORDER BY created_at LIMIT 1').get();
  assert.ok(media);
  const base = { postId: media.post_id, title: 'MAX cases', text: 'Текст', media: [media],
    credentials: { accessToken: maxSecret, chatId: '-100777' }, publicMediaUrls: [], publicationKind: 'FEED', contentFormat: 'IMAGE' };
  const beforeCarousel = writes();
  await maxPublisher.publish({ ...base, contentFormat: 'CAROUSEL', media: [media, media] });
  assert.equal(writes(), beforeCarousel + 1, 'carousel creates one message after all uploads');
  const lastBody = JSON.parse(calls.filter(c => c.method === 'messages').at(-1).init.body);
  assert.equal(lastBody.attachments.length, 2);
  assert.notEqual(lastBody.attachments[0].payload.token, lastBody.attachments[1].payload.token);

  let count = calls.length;
  await assert.rejects(maxPublisher.publish({ ...base, media: [media, { ...media, relative_path: 'missing.jpg' }], contentFormat: 'CAROUSEL' }),
    error => error.outcomeUnknown === false && error.retryable === false);
  assert.equal(calls.length, count, 'missing later file must be rejected before any remote preparation');
  for (const mode of ['host', 'reserve-503', 'binary-503', 'missing-token']) {
    uploadMode = mode;
    const before = writes();
    await assert.rejects(maxPublisher.publish(base), error => error.outcomeUnknown === false);
    assert.equal(writes(), before, 'preparation failure must not create public message');
  }
  uploadMode = 'ok';
  for (const mode of ['not-ready', 'network', 'missing-id']) {
    messageMode = mode;
    await assert.rejects(maxPublisher.publish(base), error => mode === 'not-ready'
      ? error.retryable === true && error.outcomeUnknown === false
      : error.retryable === false && error.outcomeUnknown === true);
  }
  messageMode = 'ok';
  const rich = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '🙂 текст'.repeat(160), marks: [{ type: 'bold' }] }] }] };
  const compiled = compilePlatformText('telegram', rich, 'text');
  const beforeLongText = writes();
  await telegramPublisher.publish({ ...base, media: [], contentFormat: 'TEXT_ONLY', credentials: { botToken: tgSecret, chatId: '@fixture_channel' },
    text: compiled.plainText, textCompilation: compiled });
  assert.equal(writes(), beforeLongText + 1, 'long TEXT_ONLY must use exactly one sendMessage');
  const textBody = JSON.parse(calls.filter(c => c.method === 'sendMessage').at(-1).init.body);
  assert.deepEqual(textBody.entities, compiled.transport.entities);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ ok: true, checkpoint: 'TG-MAX-FEED-PUBLISH-001', ordinarySaveReadyPublish: true,
    secretNonLeakage: true, localhostImageUpload: true, carouselTokens: true, preparationAndPublicErrorBoundaries: true, richTextOnly: true }));
} finally {
  await browser?.close();
  globalThis.fetch = originalFetch;
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
