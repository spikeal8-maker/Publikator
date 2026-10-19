import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-photo-roles-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: dataDir, ADMIN_PASSWORD: 'photo-roles-password',
  APP_MASTER_KEY: 'photo-roles-master-key-longer-than-thirty-two-characters', PUBLIC_BASE_URL: 'http://127.0.0.1:18095' });
const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
const { decryptJson } = await import('../dist/crypto.js');
const { vkPublisher } = await import('../dist/platforms/vk.js');
const { inspectSocialCredential } = await import('../dist/platforms/credential-inspection.js');
migrate();
const app = await buildApp();
const originalFetch = globalThis.fetch;
const primary = 'fixture-wall-group-secret';
const secondary = 'fixture-photo-user-secret';
const calls = [];
let helperAllowed = true;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://pu.vk.com/photo-fixture-upload') {
    assert.ok(init.body instanceof FormData);
    assert.ok(init.body.get('photo'));
    calls.push({ method: 'binaryUpload', token: null });
    return Response.json({ server: 123, photo: 'opaque-fixture', hash: 'hash-fixture' });
  }
  const method = /\/method\/([^/?]+)/.exec(url)?.[1];
  const params = new URLSearchParams(String(init.body || ''));
  const token = params.get('access_token');
  calls.push({ method, token });
  const fail = (code, message) => Response.json({ error: { error_code: code, error_msg: message } });
  if (method === 'groups.getTokenPermissions') {
    if (token !== primary) return fail(27, 'not a group token');
    return Response.json({ response: { permissions: [{ name: 'wall' }] } });
  }
  if (method === 'groups.getById') {
    assert.equal(token, primary);
    assert.equal(params.has('group_id'), false);
    return Response.json({ response: { groups: [{ id: 67890, name: 'Paired community', screen_name: 'club67890' }] } });
  }
  if (method === 'account.getAppPermissions') {
    if (token === 'service-fixture') return fail(27, 'method unavailable with service authorization');
    if (token !== secondary) return fail(5, 'access_token was given to another ip address');
    return Response.json({ response: 4 });
  }
  if (method === 'users.get') return Response.json({ response: [{ id: 20401871, first_name: 'Fixture', screen_name: 'fixture' }] });
  if (method === 'photos.getWallUploadServer') {
    if (token !== secondary) return fail(27, 'method unavailable with group authorization');
    if (!helperAllowed) return fail(15, 'photo access revoked');
    assert.equal(params.get('group_id'), '67890');
    return Response.json({ response: { upload_url: 'https://pu.vk.com/photo-fixture-upload' } });
  }
  if (method === 'photos.saveWallPhoto') {
    assert.equal(token, secondary);
    assert.equal(params.get('group_id'), '67890');
    return Response.json({ response: [{ id: 321, owner_id: -67890 }] });
  }
  if (method === 'wall.post') {
    assert.equal(token, primary, 'wall credential must never be the upload credential');
    assert.equal(params.get('owner_id'), '-67890');
    assert.equal(params.get('from_group'), '1');
    assert.equal(params.get('attachments'), 'photo-67890_321');
    return Response.json({ response: { post_id: 987 } });
  }
  throw new Error('Unexpected method ' + method);
};
let browser;
try {
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const req = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  await app.listen({ host: '127.0.0.1', port: 18095 });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:18095/socials');
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('.operator-add-platform[data-platform="vk"]').click();
  const connect = page.locator('#operator-social-form');
  await connect.locator('input[name="name"]').fill('Paired VK');
  await connect.locator('input[name="destinationKind"][value="COMMUNITY"]').check();
  await connect.locator('input[name="groupId"]').fill('67890');
  await connect.locator('input[name="accessToken"]').fill(primary);
  await connect.locator('input[name="uploadAccessToken"]').fill(secondary);
  await page.locator('#operator-test-connect').click();
  await page.waitForFunction(() => document.querySelector('#operator-save-connect')?.disabled === false);
  await page.locator('#operator-save-connect').click();
  await connect.waitFor({ state: 'detached' });
  const account = db.prepare('SELECT * FROM social_accounts WHERE name=?').get('Paired VK');
  assert.ok(account);
  const credentials = decryptJson(account.credentials_encrypted);
  assert.equal(credentials.accessToken, primary);
  assert.equal(credentials.uploadAccessToken, secondary);
  assert.equal(credentials.photoPublishReady, true);
  assert.equal(credentials.uploadUserId, '20401871');
  const accounts = await req('GET', '/api/accounts');
  assert.equal(accounts.body.includes(primary), false);
  assert.equal(accounts.body.includes(secondary), false);
  assert.equal(accounts.json()[0].photo_publish_ready, true);
  assert.equal(accounts.json()[0].capabilityProfile.semantic.publicationReadiness.IMAGE.state, 'READY');
  const inspected = await inspectSocialCredential('vk', credentials);
  assert.equal(inspected.credential.providerType, 'GROUP');
  assert.equal(inspected.publicationEvidence.IMAGE.state, 'CONFIRMED');
  assert.equal(calls.some(item => ['binaryUpload', 'photos.saveWallPhoto', 'wall.post'].includes(item.method)), false);

  await page.goto('http://127.0.0.1:18095/content');
  await page.locator('#new-post').click();
  let form = page.locator('#post-form');
  await form.locator('input[name="title"]').fill('Photo with separate roles');
  await form.locator('[contenteditable="true"]').first().fill('Photo-role acceptance through the ordinary editor');
  await form.locator('button[type="submit"]').click();
  await form.waitFor({ state: 'detached' });
  async function edit() {
    await page.getByRole('row').filter({ hasText: 'Photo with separate roles' }).getByRole('button', { name: 'Открыть', exact: true }).click();
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page.locator('.platform-editor-card').waitFor({ state: 'visible' });
    return page.locator('#post-form');
  }
  form = await edit();
  const imagePath = path.join(dataDir, 'image.jpg');
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#225588' } }).jpeg().toFile(imagePath);
  await form.locator('#media-file').setInputFiles(imagePath);
  await form.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page.locator('#post-form .media-list img').waitFor({ state: 'visible' });
  await page.locator('.platform-editor-card').waitFor({ state: 'visible' });
  form = page.locator('#post-form');
  await form.locator('#mark-ready').click();
  await form.waitFor({ state: 'detached' });
  assert.equal(calls.some(item => ['binaryUpload', 'photos.saveWallPhoto', 'wall.post'].includes(item.method)), false);
  form = await edit();
  await form.locator('#publish-now').click();
  await form.waitFor({ state: 'detached' });
  const post = db.prepare('SELECT * FROM posts WHERE title=?').get('Photo with separate roles');
  assert.equal(post.status, 'PUBLISHED');
  assert.equal(calls.filter(item => item.method === 'wall.post').length, 1);
  assert.equal(calls.filter(item => item.method === 'binaryUpload').length, 1);
  assert.equal(calls.filter(item => item.method === 'photos.saveWallPhoto').length, 1);

  const bad = await req('POST', '/api/accounts', { platform: 'vk', name: 'IP blocked helper', credentials: {
    ...credentials, uploadAccessToken: 'bad-helper', photoPublishReady: true, uploadUserId: '20401871'
  } });
  assert.equal(bad.statusCode, 201, bad.body);
  const partial = decryptJson(db.prepare('SELECT credentials_encrypted FROM social_accounts WHERE id=?').get(bad.json().id).credentials_encrypted);
  assert.equal(partial.photoPublishReady, false);
  assert.equal(partial.textPublishReady, true);
  assert.equal(bad.json().capabilityProfile.semantic.publicationReadiness.IMAGE.state, 'SETUP_REQUIRED');
  assert.match(partial.photoSetupError, /IP/i);
  const service = await req('POST', '/api/accounts', { platform: 'vk', name: 'Service helper', credentials: {
    ...credentials, uploadAccessToken: 'service-fixture', photoPublishReady: true
  } });
  assert.equal(service.statusCode, 201, service.body);
  assert.equal(service.json().capabilityProfile.semantic.publicationReadiness.IMAGE.state, 'SETUP_REQUIRED');

  const media = db.prepare('SELECT * FROM media WHERE post_id=?').all(post.id);
  const direct = { postId: post.id, title: post.title, text: post.body, media, publicMediaUrls: [], credentials,
    publicationKind: 'FEED', contentFormat: 'IMAGE' };
  assert.throws(() => vkPublisher.validate({ ...direct, credentials: partial }), /пользовательский ключ/);
  assert.throws(() => vkPublisher.validate({ ...direct, publicationKind: 'STORY' }), /ленте/);
  helperAllowed = false;
  await assert.rejects(vkPublisher.publish(direct), /revoked/);
  assert.equal(calls.filter(item => item.method === 'binaryUpload').length, 1);
  assert.equal(calls.filter(item => item.method === 'wall.post').length, 1);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ ok: true, checkpoint: 'VK-PHOTO-CREDENTIAL-ROLES-001',
    ordinaryTwoKeySaveAndPhotoPublish: true, encryptedBoth: true, separateApiRoles: true,
    invalidHelperKeepsText: true, serviceCannotMasqueradeAsUser: true, revokedHelperBeforeUpload: true }));
} finally {
  await browser?.close();
  globalThis.fetch = originalFetch;
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
