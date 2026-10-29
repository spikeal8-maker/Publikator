import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-sources-ux-'));
process.env.DATA_DIR = dir; process.env.NODE_ENV = 'test';
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
let denySheet = true, denyDrive = false, inspectCalls = 0, saves = 0, yandexStatus = 0, yandexInspects = 0;
let holdNextGoogleList = false, releaseGoogleList = null;
const errors = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route(/\/api\/(google-sheets|google-drive|yandex-disk)\//, async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const method = request.method(), body = method === 'GET' ? {} : request.postDataJSON();
    let result = {}, status = 200;
    const kind = pathname.split('/')[2], list = kind === 'google-sheets' ? google : kind === 'google-drive' ? drive : yandex;
    if (pathname.endsWith('/connectors') && method === 'GET') result = { connectors: list };
    else if (pathname === '/api/google-sheets/setup/inspect') {
      inspectCalls++;
      assert.equal(body.spreadsheetId, 'fixture_sheet_12345');
      if (body.existingConnectorId) {
        assert.equal(body.existingConnectorId, google[0].id);
        assert.equal(body.credentials, undefined, 'saved secret is never sent back through browser');
      } else assert.equal(body.credentials.client_email, key.client_email);
      result = {
        serviceAccountEmail: key.client_email, spreadsheetId: body.spreadsheetId,
        sheet: denySheet ? { ok: false, message: 'Нет доступа к таблице (403). Настройки доступа: добавьте email сервисного аккаунта.' } : { ok: true, value: { spreadsheetTitle: 'Fixture plan', sheets: ['Публикации', 'Второй лист'] } },
        folder: body.rootFolder ? (denyDrive ? { ok: false, message: 'Нет доступа к папке (403). Проверьте доступ к папке.' } : { ok: true, value: { rootFolderName: 'Фото', rootFolderId: 'fixture_folder_123' } }) : null,
        canSave: !denySheet && (!body.rootFolder || !denyDrive)
      };
    } else if (pathname === '/api/google-sheets/setup/save') {
      saves++;
      let connector = google[0];
      if (!body.existingConnectorId) {
        connector = { id: 'fixture-sheet', name: body.name, enabled: true, config: { spreadsheetId: body.spreadsheetId, sheetName: body.sheetName, writeBack: body.writeBack, serviceAccountEmail: key.client_email, pollingEnabled: false, autoApplyEnabled: false, autoReadyEnabled: false, pollIntervalMinutes: 15 }, polling: {} };
        google.push(connector);
      } else assert.equal(body.credentials, undefined);
      let folder = null;
      if (body.rootFolder) {
        folder = { id: 'fixture-folder-' + saves, name: body.mediaName, config: { rootFolderId: 'fixture_folder_123', rootFolderName: 'Фото', serviceAccountEmail: key.client_email } };
        drive.push(folder);
      }
      result = { sheetConnector: connector, mediaConnector: folder };
    } else if (pathname.endsWith('/inspect') && kind === 'yandex-disk') {
      yandexInspects++;
      assert.equal(body.credentials.oauthToken, 'synthetic-yandex-token-for-tests-only');
      assert.equal(body.rootPath, '/Фото');
      if (yandexStatus) { status = 400; result = { error: 'Yandex Disk API failed (HTTP ' + yandexStatus + ')' }; }
      else result = { rootPath: 'disk:/Фото', rootFolderName: 'Фото' };
    } else if (pathname.endsWith('/connectors') && method === 'POST' && kind === 'yandex-disk') {
      const connector = { id: 'fixture-yandex', name: body.name, config: { rootPath: 'disk:/Фото', rootFolderName: 'Фото' } };
      yandex.push(connector); status = 201; result = { connector };
    } else if (pathname.endsWith('/test')) result = { ok: true };
    else throw new Error('Unexpected mocked operation: ' + method + ' ' + pathname);
    if (holdNextGoogleList && method === 'GET' && pathname === '/api/google-sheets/connectors') {
      holdNextGoogleList = false;
      await new Promise(resolve => { releaseGoogleList = resolve; });
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto('http://127.0.0.1:18892/');
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('#app:not(.hidden)').waitFor();
  await page.locator('[data-route="/sources"]').click();
  await page.locator('#gs-open-connect').waitFor();
  assert.equal(await page.locator('.operator-connections-panel').count(), 0);
  assert.equal(await page.locator('#operator-source-file').isVisible(), true);
  assert.equal(await page.locator('.sources-compact > details').count(), 0);
  assert.equal(await page.locator('#sources-open-api').isVisible(), true);
  await page.locator('#sources-help').click();
  assert.match(await page.locator('#sources-help-panel').innerText(), /source_revision[\s\S]*403/);
  await page.keyboard.press('Escape');
  const initialScroll = await page.evaluate(() => window.scrollY);
  assert.ok(await page.locator('.operator-source-layout').evaluate(el => el.getBoundingClientRect().height < 800));
  const focusSnapshots = [];
  async function verifyModalTabs(phase, key, count = 12) {
    for (let press = 1; press <= count; press++) {
      await page.keyboard.press(key);
      const state = await page.evaluate(() => {
        const dialog = document.querySelector('dialog.gs-setup-dialog');
        const active = document.activeElement;
        return {
          activeTag: active?.tagName || '',
          activeId: active?.id || '',
          dialogOpen: dialog?.open === true,
          modal: dialog?.matches(':modal') === true,
          formPresent: !!document.querySelector('#gs-connect-form'),
          focusInside: dialog?.contains(active) === true
        };
      });
      focusSnapshots.push({ phase, key, press, ...state });
      assert.ok(state.dialogOpen && state.modal && state.focusInside,
        'keyboard stays in dialog: ' + JSON.stringify({ phase, key, press, ...state }));
    }
  }

  // A blocked connector response must leave the modal keyboard-accessible.
  holdNextGoogleList = true;
  await page.locator('#gs-open-connect').click();
  await page.locator('#gs-loading-close').waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 1);
  assert.equal(await page.locator('#gs-connect-form').count(), 0, 'form is still loading');
  assert.equal(await page.evaluate(() => window.scrollY), initialScroll, 'opening setup does not jump page');
  await verifyModalTabs('loading', 'Tab');
  await verifyModalTabs('loading', 'Shift+Tab');
  assert.equal(typeof releaseGoogleList, 'function', 'controlled Google API request is pending');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'gs-open-connect');
  releaseGoogleList();
  releaseGoogleList = null;

  // Fast fixture response: the rendered form must trap forward and reverse Tab.
  await page.locator('#gs-open-connect').click();
  await page.locator('#gs-connect-form').waitFor();
  assert.equal(await page.evaluate(() => window.scrollY), initialScroll);
  await verifyModalTabs('loaded', 'Tab');
  await verifyModalTabs('loaded', 'Shift+Tab');
  const focusableSelector = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';
  const focusBoundary = async side => page.evaluate(({ selector, side }) => {
    const dialog = document.querySelector('dialog.gs-setup-dialog');
    const nodes = Array.from(dialog.querySelectorAll(selector)).filter(element =>
      element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
    nodes[side === 'first' ? 0 : nodes.length - 1].focus();
    return nodes.length;
  }, { selector: focusableSelector, side });
  assert.ok(await focusBoundary('last') > 1);
  await verifyModalTabs('last-to-first', 'Tab', 1);
  assert.ok(await focusBoundary('first') > 1);
  await verifyModalTabs('first-to-last', 'Shift+Tab', 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'gs-open-connect');
  await page.locator('#gs-open-connect').click();
  await page.locator('#gs-connect-form').waitFor();
  assert.equal(await page.evaluate(() => window.scrollY), initialScroll);
  console.log(JSON.stringify({ checkpoint: 'GOOGLE-DIALOG-KEYBOARD', ok: true, focusSnapshots }));
  await page.locator('summary[aria-label="Справка: Один аккаунт для Google"]').press('Enter');
  assert.match(await page.locator('.gs-setup-guide').first().innerText(), /Сервисные аккаунты/);
  await page.locator('[name=name]').fill('Fixture plan');
  await page.locator('[name=spreadsheetId]').fill('https://docs.google.com/spreadsheets/d/fixture_sheet_12345/edit');
  await page.locator('[name=rootFolder]').fill('https://drive.google.com/drive/folders/fixture_folder_123');
  await page.locator('[name=mediaName]').fill('Фото проекта');
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
  assert.match(await page.locator('#gs-share-hint').innerText(), /Таблица:.*Редактор[\s\S]*Папка Google Drive:.*Читатель/);
  await page.locator('#gs-inspect').click();
  await page.waitForFunction(() => document.querySelector('#gs-connect-result').textContent.includes('(403)'));
  assert.equal(await page.locator('#gs-save').isDisabled(), true);
  assert.ok(!(await page.locator('#gs-connect-result').innerText()).includes(key.private_key));
  denySheet = false;
  await page.locator('#gs-inspect').click();
  await page.waitForFunction(() => !document.querySelector('#gs-save').disabled);
  await page.locator('[name=sheetName]').selectOption('Второй лист');
  await page.locator('[name=writeBack]').check();
  await page.locator('[name=name]').fill('Renamed fixture');
  assert.equal(await page.locator('#gs-save').isEnabled(), true);
  await page.locator('#gs-save').click();
  await page.locator('.gs-connector').waitFor();
  assert.equal(google.length, 1);
  assert.equal(drive.length, 1, 'single save creates table and folder');
  assert.equal(google[0].config.sheetName, 'Второй лист');
  assert.equal(google[0].config.writeBack, true);
  assert.equal(await page.locator('[name=credentials]').count(), 0);
  assert.match(await page.locator('.gs-state-grid').innerText(), /Автоматически не проверяется[\s\S]*Вручную после проверки[\s\S]*Требует вашей проверки/);
  assert.equal(await page.locator('.gs-automation').getAttribute('open'), null);
  await page.locator('.gs-settings').click();
  await page.locator('summary[aria-label="Справка: Автоматическая готовность"]').press('Enter');
  assert.match(await page.locator('.gs-ready-setting').innerText(), /Может привести к реальной отправке/);
  assert.equal(await page.locator('.gs-auto-ready').isChecked(), false);
  assert.equal(await page.locator('.gs-auto-ready').isDisabled(), true);
  await page.locator('.gs-poll-enabled').check();
  assert.equal(await page.locator('.gs-unsaved').isVisible(), true);
  assert.equal(google[0].config.pollingEnabled, false, 'editing settings does not persist before Save');
  await page.locator('.gs-poll-enabled').uncheck();

  await page.locator('.gs-settings-close').click();
  await page.locator('.gs-add-folder').click();
  await page.locator('#gs-connect-form').waitFor();
  assert.equal(await page.locator('[name=existingConnectorId]').inputValue(), 'fixture-sheet');
  assert.equal(await page.locator('[name=credentials]').isVisible(), false);
  assert.equal(await page.locator('[name=credentials]').inputValue(), '');
  assert.equal(await page.locator('[name=spreadsheetId]').getAttribute('readonly'), '');
  await page.locator('[name=rootFolder]').fill('https://drive.google.com/drive/folders/second_fixture_123');
  await page.locator('[name=mediaName]').fill('Другие фото');
  denyDrive = true;
  await page.locator('#gs-inspect').click();
  await page.waitForFunction(() => document.querySelector('#gs-connect-result').textContent.includes('Папка: нужна проверка'));
  assert.match(await page.locator('#gs-connect-result').innerText(), /Таблица: чтение доступно/);
  assert.equal(await page.locator('#gs-save').isDisabled(), true);
  denyDrive = false;
  await page.locator('#gs-inspect').click();
  await page.waitForFunction(() => !document.querySelector('#gs-save').disabled);
  await page.locator('[name=rootFolder]').fill('https://drive.google.com/drive/folders/third_fixture_123');
  assert.equal(await page.locator('#gs-save').isDisabled(), true);
  await page.locator('#gs-inspect').click();
  await page.waitForFunction(() => !document.querySelector('#gs-save').disabled);
  await page.locator('#gs-save').click();
  await page.waitForFunction(() => document.querySelector('#gs-cloud-list').textContent.includes('Другие фото'));
  assert.equal(google.length, 1, 'existing table is not duplicated');
  assert.equal(drive.length, 2);
  assert.equal(saves, 2);
  await page.locator('#gs-add-yandex').click();
  assert.equal(await page.locator('dialog[open]').count(), 1);
  await page.locator('.gs-yandex-guide > summary').click();
  assert.match(await page.locator('.gs-yandex-guide').innerText(), /Чтение всего Диска[\s\S]*cloud_api:disk.read[\s\S]*ClientID[\s\S]*access_token/);
  const yandexGuide = await page.locator('.gs-yandex-guide').innerText();
  assert.match(yandexGuide, /Настройки.*Доступ к данным/);
  assert.match(yandexGuide, /Да, сохранить/);
  assert.match(yandexGuide, /Доступ к папке приложения на Диске.*другое право/);
  assert.match(yandexGuide, /Старый токен не получает новые права/);
  await page.locator('[name=clientId]').fill('spikeal');
  assert.equal(await page.locator('.gs-yandex-authorize').getAttribute('href'), null);
  assert.match(await page.locator('.gs-yandex-client-hint').innerText(), /не похоже на ClientID/);
  await page.locator('[name=clientId]').fill('fixtureclient1234567890');
  assert.equal(await page.locator('.gs-yandex-authorize').getAttribute('href'), 'https://oauth.yandex.ru/authorize?response_type=token&client_id=fixtureclient1234567890');
  const media = page.locator('.gs-media-form');
  await media.locator('[name=name]').fill('Фото Яндекс');
  await media.locator('[name=root]').fill('/Фото');
  await media.locator('[name=secret]').fill('fixtureclient1234567890');
  await media.locator('.gs-media-inspect').click();
  assert.match(await media.locator('.gs-media-result').innerText(), /вставлен ClientID/);
  assert.equal(yandexInspects, 0);
  await media.locator('[name=secret]').fill('synthetic-yandex-token-for-tests-only');
  assert.equal(await media.locator('[name=secret]').getAttribute('autocomplete'), 'new-password');
  for (const [code, expected] of [[401, /не принял токен/], [403, /отклонил доступ/], [404, /не найдена/]]) {
    yandexStatus = code;
    await media.locator('.gs-media-inspect').click();
    await page.waitForFunction(code => document.querySelector('.gs-media-result').textContent.includes('(' + code + ')'), code);
    assert.match(await media.locator('.gs-media-result').innerText(), expected);
    assert.equal(await media.locator('.gs-media-save').isDisabled(), true);
  }
  yandexStatus = 0;
  await media.locator('[name=secret]').fill('https://oauth.yandex.ru/verification_code#access_token=synthetic-yandex-token-for-tests-only&expires_in=3600');
  assert.equal(await media.locator('[name=secret]').getAttribute('type'), 'password');
  await media.locator('.gs-media-inspect').click();
  await page.waitForFunction(() => !document.querySelector('.gs-media-save').disabled);
  await media.locator('.gs-media-save').click();
  await page.waitForFunction(() => document.querySelector('#gs-cloud-list').textContent.includes('Фото Яндекс'));
  assert.equal(yandex.length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM posts').get().n, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#gs-open-connect').click();
  await page.locator('#gs-connect-form').waitFor();
  await page.locator('summary[aria-label="Справка: Как подключить папку изображений"]').press('Enter');
  assert.match(await page.locator('#gs-connect-form').innerText(), /Отдельный JSON создавать не нужно/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '390px no horizontal overflow with detailed help');
  await fs.mkdir('artifacts/sources-ux', { recursive: true });
  assert.ok(await page.locator('dialog[open]').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'dialog has no horizontal overflow');
  await page.screenshot({ path: 'artifacts/sources-ux/mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.locator('#gs-add-yandex').click();
  await page.locator('.gs-yandex-guide > summary').click();
  assert.match(await page.locator('dialog[open]').innerText(), /ClientID/);
  await page.screenshot({ path: 'artifacts/sources-ux/yandex-mobile.png', fullPage: true });
  assert.ok(await page.locator('dialog[open]').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Yandex guide has no horizontal overflow');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const workspace = await page.locator('.sources-compact').boundingBox();
  assert.ok(workspace.height <= 650, 'realistic source list + file import must fit compact desktop height: ' + workspace.height);
  assert.ok((await page.locator('#view').innerText()).length < 1800, 'working page must not contain instruction walls');
  assert.equal(await page.locator('#operator-source-file').isVisible(), true);
  await page.screenshot({ path: 'artifacts/sources-ux/desktop.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('SOURCES-UX + GOOGLE-SETUP: single window/key, reuse without readback, separate failures, media and mobile help PASS');
} finally {
  await browser?.close(); await app.close(); db.close();
  await fs.rm(dir, { recursive: true, force: true });
}
