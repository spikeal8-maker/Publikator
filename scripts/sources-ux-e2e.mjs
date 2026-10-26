import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-sources-ux-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'sources-ux-test-password';
process.env.APP_MASTER_KEY = 'sources-ux-fixture-key-longer-than-thirty-two';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:18892';
const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();
await app.listen({ port: 18892, host: '127.0.0.1' });
let browser;
const key = { type: 'service_account', client_email: 'fixture@source-test.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_NOT_A_REAL_KEY\n-----END PRIVATE KEY-----' };
const google = [], drive = [], yandex = [];
let denySheet = true, inspectCalls = 0, creates = 0;
const errors = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route(/\/api\/(google-sheets|google-drive|yandex-disk)\//, async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'GET' ? {} : request.postDataJSON();
    let result = {}, status = 200;
    const kind = pathname.split('/')[2];
    const list = kind === 'google-sheets' ? google : kind === 'google-drive' ? drive : yandex;
    if (pathname.endsWith('/connectors') && method === 'GET') result = { connectors: list };
    else if (pathname === '/api/google-sheets/inspect') {
      inspectCalls++;
      assert.equal(body.spreadsheetId, 'fixture_sheet_12345');
      assert.equal(body.credentials.client_email, key.client_email);
      if (denySheet) { status = 400; result = { error: 'Google Sheets metadata request failed (HTTP 403)' }; }
      else result = { spreadsheetTitle: 'Fixture plan', sheets: ['Публикации', 'Второй лист'], serviceAccountEmail: key.client_email };
    } else if (pathname.endsWith('/inspect')) {
      if (kind === 'google-drive') {
        assert.equal(body.credentials.client_email, key.client_email);
        assert.equal(body.rootFolder, 'https://drive.google.com/drive/folders/fixture_folder_123');
        result = { rootFolderName: 'Fixture photos', rootFolderId: 'fixture_folder_123', serviceAccountEmail: key.client_email };
      } else {
        assert.equal(body.credentials.oauthToken, 'synthetic-yandex-token-for-tests-only');
        assert.equal(body.rootPath, '/Фото');
        result = { rootPath: 'disk:/Фото', rootFolderName: 'Фото' };
      }
    } else if (pathname.endsWith('/connectors') && method === 'POST') {
      creates++;
      const config = kind === 'google-sheets'
        ? { spreadsheetId: body.spreadsheetId, sheetName: body.sheetName, writeBack: body.writeBack, serviceAccountEmail: key.client_email, pollingEnabled: false, autoApplyEnabled: false, autoReadyEnabled: false, pollIntervalMinutes: 15 }
        : kind === 'google-drive'
          ? { rootFolderName: 'Fixture photos', rootFolderId: 'fixture_folder_123', serviceAccountEmail: key.client_email }
          : { rootPath: 'disk:/Фото', rootFolderName: 'Фото' };
      const connector = { id: 'fixture-' + kind, name: body.name, config, polling: {} };
      list.push(connector); status = 201; result = { connector };
    } else if (pathname.endsWith('/test')) result = { ok: true };
    else throw new Error('Unexpected mocked operation: ' + method + ' ' + pathname);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto('http://127.0.0.1:18892/');
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('#app:not(.hidden)').waitFor();
  await page.locator('[data-route="/sources"]').click();
  await page.locator('#gs-add-drive').waitFor();
  assert.ok(await page.locator('.operator-source-layout').evaluate(el => el.getBoundingClientRect().height < 800), 'no navigation-sidebar styling on Sources content panel');
  await page.locator('#gs-open-connect').click();
  await page.getByRole('button', { name: 'Справка: Где найти JSON', exact: true }).press('Enter');
  assert.match(await page.locator('.gs-setup-guide').innerText(), /Сервисные аккаунты/);
  await page.locator('[name=name]').fill('Fixture plan');
  await page.locator('[name=spreadsheetId]').fill('https://docs.google.com/spreadsheets/d/fixture_sheet_12345/edit');
  await page.locator('[name=credentials]').fill('{broken');
  await page.locator('#gs-inspect').click();
  await page.waitForFunction(() => document.querySelector('#gs-connect-result').textContent.includes('целиком'));
  assert.equal(inspectCalls, 0);
  await page.locator('[name=credentials]').fill(JSON.stringify({ type: 'authorized_user' }));
  await page.locator('#gs-inspect').click();
  await page.waitForFunction(() => document.querySelector('#gs-connect-result').textContent.includes('OAuth Client ID'));
  assert.equal(inspectCalls, 0);
  await page.locator('#gs-json-file').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(key)) });
  await page.waitForFunction(() => document.querySelector('#gs-share-hint').textContent.includes('fixture@source-test'));
  await page.locator('#gs-inspect').click();
  await page.waitForFunction(() => document.querySelector('#gs-connect-result').textContent.includes('(403)'));
  assert.match(await page.locator('#gs-connect-result').innerText(), /Настройки доступа.*fixture@source-test/);
  assert.ok(!(await page.locator('#gs-connect-result').innerText()).includes(key.private_key));
  denySheet = false;
  await page.locator('#gs-inspect').click();
  await page.waitForFunction(() => !document.querySelector('#gs-save').disabled);
  await page.locator('[name=sheetName]').selectOption('Второй лист');
  await page.locator('[name=writeBack]').check();
  await page.locator('[name=name]').fill('Renamed fixture');
  assert.equal(await page.locator('#gs-save').isEnabled(), true, 'name/leaf options must not discard verified identity');
  await page.locator('#gs-save').click();
  await page.locator('.gs-connector').waitFor();
  assert.equal(google[0].config.sheetName, 'Второй лист');
  assert.equal(google[0].config.writeBack, true);
  await page.getByRole('button', { name: 'Справка: Автоматическая готовность', exact: true }).press('Enter');
  assert.match(await page.locator('.gs-ready-setting').innerText(), /Может привести к реальной отправке/);
  assert.equal(await page.locator('.gs-auto-ready').isChecked(), false);
  assert.equal(await page.locator('.gs-auto-ready').isDisabled(), true);

  await page.locator('#gs-add-drive').click();
  const media = page.locator('.gs-media-form');
  await media.locator('[name=name]').fill('Фото проекта');
  await media.locator('[name=root]').fill('https://drive.google.com/drive/folders/fixture_folder_123');
  await media.locator('[name=secret]').fill(JSON.stringify(key));
  assert.match(await media.locator('.gs-drive-email').innerText(), /fixture@source-test.*Читатель/);
  await media.locator('.gs-media-inspect').click();
  await page.waitForFunction(() => !document.querySelector('.gs-media-save').disabled);
  await media.locator('[name=name]').fill('Фото проекта новое');
  assert.equal(await media.locator('.gs-media-save').isDisabled(), true);
  await media.locator('.gs-media-inspect').click();
  await page.waitForFunction(() => !document.querySelector('.gs-media-save').disabled);
  await media.locator('.gs-media-save').click();
  await page.waitForFunction(() => document.querySelector('#gs-cloud-list').textContent.includes('Фото проекта новое'));
  assert.equal(drive.length, 1);
  assert.equal(await page.locator('.gs-media-form').count(), 0, 'secret input removed after save');
  await page.locator('#gs-add-yandex').click();
  await media.locator('[name=name]').fill('Фото Яндекс');
  await media.locator('[name=root]').fill('/Фото');
  await media.locator('[name=secret]').fill('synthetic-yandex-token-for-tests-only');
  assert.equal(await media.locator('[name=secret]').getAttribute('type'), 'password');
  await media.locator('.gs-media-inspect').click();
  await page.waitForFunction(() => !document.querySelector('.gs-media-save').disabled);
  await media.locator('.gs-media-save').click();
  await page.waitForFunction(() => document.querySelector('#gs-cloud-list').textContent.includes('Фото Яндекс'));
  assert.equal(yandex.length, 1);
  assert.equal(creates, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM posts').get().n, 0, 'connecting sources never publishes or creates posts');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#gs-add-drive').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '390px page has no horizontal overflow');
  await fs.mkdir('artifacts/sources-ux', { recursive: true });
  await page.screenshot({ path: 'artifacts/sources-ux/mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('SOURCES-UX-001: guided JSON/403/sharing, stable verification, cloud forms, no publish, desktop/mobile PASS');
} finally {
  await browser?.close();
  await app.close();
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
}
