import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-social-error-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  ADMIN_PASSWORD: 'social-observability-test-password',
  APP_MASTER_KEY: 'social-observability-test-encryption-key-over-32-chars',
  PUBLIC_BASE_URL: 'http://127.0.0.1:18107'
});

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();

const fakeToken = '123456:FAKE-OBSERVABILITY-TEST-TOKEN';
const fakeMaxToken = 'FAKE-MAX-OBSERVABILITY-SECRET';
const fakeSavedToken = '765432:FAKE-SAVED-TELEGRAM-CREDENTIAL';
const fakeVkToken = 'vk1.a.FAKE_SAVED_VK_KEY_NO_REAL_CREDENTIAL';
const originalFetch = globalThis.fetch;
let scenario = 'echo-error';
let publicWrites = 0;
const safeCalls = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  safeCalls.push(url.hostname);
  if (/sendMessage|sendPhoto|wall\.post|\/messages$/.test(url.pathname)) {
    publicWrites++;
    throw new Error('No public provider POST permitted in diagnostic tests');
  }
  if (url.hostname === 'api.vk.com' && scenario === 'vk-ip-echo') {
    return Response.json({ error: {
      error_code: 5,
      error_msg: 'User authorization failed from another ip address for token ' + fakeVkToken
    } });
  }
  if (url.hostname === 'platform-api2.max.ru' && scenario === 'max-permission-echo') {
    throw new Error('MAX permission denied for token ' + fakeMaxToken);
  }
  if (url.hostname !== 'api.telegram.org') throw new Error('Unexpected diagnostic provider host');
  if (scenario === 'echo-error' || scenario === 'saved-echo-error') {
    const secret = scenario === 'saved-echo-error' ? fakeSavedToken : fakeToken;
    throw new Error('network failure at https://api.telegram.org/bot' + secret +
      '/getMe?access_token=' + encodeURIComponent(secret));
  }
  const failures = {
    'dns-failure': 'ENOTFOUND api.telegram.org',
    'tls-failure': 'unable to get issuer certificate TLS',
    'timeout-failure': 'ETIMEDOUT remote provider',
    'tcp-failure': 'ECONNREFUSED api.telegram.org',
    'permission-failure': 'permission denied for channel',
    'rejected-failure': 'invalid token authorization',
    'destination-failure': 'chat not found at destination'
  };
  if (Object.hasOwn(failures, scenario)) throw new Error(failures[scenario] + ' (' + fakeToken + ')');
  if (url.pathname.endsWith('/getMe')) {
    return Response.json({ ok: true, result: {
      id: 101, username: scenario === 'saved-success-echo' ? fakeSavedToken : 'fixture_diagnostic_bot'
    } });
  }
  if (url.pathname.endsWith('/getChat')) {
    return Response.json({ ok: true, result: {
      id: -10042, type: 'channel',
      title: scenario === 'saved-success-echo' ? fakeSavedToken : 'Diagnostic fixture'
    } });
  }
  if (url.pathname.endsWith('/getChatMember')) {
    return Response.json({ ok: true, result: { status: 'administrator', can_post_messages: true } });
  }
  throw new Error('Unexpected diagnostic provider method');
};

// Fixture accounts exercise errors where request.body contains NO secret.
const savedId = id('acc');
const vkId = id('acc');
const insertedAt = nowIso();
db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'telegram','Saved diagnostic bot',?,0,?,?)")
  .run(savedId, encryptJson({ botToken: fakeSavedToken, chatId: '@fixture_channel' }), insertedAt, insertedAt);
db.prepare("INSERT INTO social_accounts(id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,'vk','Saved VK pending',?,0,?,?)")
  .run(vkId, encryptJson({ accessToken: fakeVkToken, authKind: 'PENDING',
    destinationKind: 'COMMUNITY', groupId: '234601853', apiVersion: '5.199' }), insertedAt, insertedAt);

// PR #153 has not landed. Simulate its route to verify the same hook contract.
app.post('/api/accounts/:id/recheck', async (request, reply) => {
  if (scenario === 'unhandled-echo') {
    throw new Error('Unexpected provider exception contained saved token ' + fakeSavedToken);
  }
  return reply.code(503).send({
    error: 'TLS certificate failure for ' + fakeSavedToken,
    nested: { accessToken: fakeSavedToken, more: ['nested-secret=' + fakeSavedToken] },
    url: 'https://service.example.test?access_token=' + fakeSavedToken
  });
});

let browser;
let persistedDiagnosticId = '';
try {
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: process.env.ADMIN_PASSWORD }
  });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];

  // Missing local input must be distinguishable from a provider outage.
  const malformed = await app.inject({
    method: 'POST',
    url: '/api/accounts/test',
    headers: { cookie },
    payload: { platform: 'telegram', credentials: { botToken: fakeToken, chatId: '' } }
  });
  assert.equal(malformed.statusCode, 400, malformed.body);
  const malformedBody = malformed.json();
  assert.equal(malformedBody.diagnosticCode, 'INVALID_INPUT', malformed.body);
  assert.ok(typeof malformedBody.diagnosticId === 'string');
  assert.equal(malformed.body.includes(fakeToken), false);

  const failed = await app.inject({
    method: 'POST',
    url: '/api/accounts/test',
    headers: { cookie },
    payload: { platform: 'telegram', credentials: { botToken: fakeToken, chatId: '@fixture_channel' } }
  });
  assert.equal(failed.statusCode, 400, failed.body);
  const failedBody = failed.json();
  assert.equal(failedBody.diagnosticCode, 'PROVIDER_UNAVAILABLE', failed.body);
  assert.ok(failedBody.diagnosticId.startsWith('socialcheck_'));
  assert.equal(failed.body.includes(fakeToken), false);
  assert.match(failedBody.error, /API площадки временно недоступен/);
  assert.deepEqual(Object.keys(failedBody).sort(), ['diagnosticCode','diagnosticId','error']);

  // A failed save is also independently visible, without saving plaintext secrets.
  const badSave = await app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers: { cookie },
    payload: { platform: 'max', name: '', credentials: { accessToken: fakeMaxToken, chatId: '-100777' } }
  });
  assert.equal(badSave.statusCode, 400, badSave.body);
  assert.ok(badSave.json().diagnosticId);
  assert.equal(badSave.body.includes(fakeMaxToken), false);

  // A previously saved token is absent from the request payload.
  scenario = 'saved-echo-error';
  const savedFailure = await app.inject({
    method: 'POST', url: '/api/accounts/' + savedId + '/test', headers: { cookie }
  });
  assert.equal(savedFailure.statusCode, 400, savedFailure.body);
  assert.equal(savedFailure.json().diagnosticCode, 'PROVIDER_UNAVAILABLE');
  assert.ok(savedFailure.json().diagnosticId.startsWith('socialcheck_'));
  persistedDiagnosticId = savedFailure.json().diagnosticId;
  assert.equal(savedFailure.body.includes(fakeSavedToken), false);
  assert.deepEqual(Object.keys(savedFailure.json()).sort(), ['diagnosticCode','diagnosticId','error']);
  assert.equal(db.prepare('SELECT enabled FROM social_accounts WHERE id=?').get(savedId).enabled, 0);

  // A future recheck route must not spread nested provider/debug fields.
  const recheck = await app.inject({
    method: 'POST', url: '/api/accounts/' + savedId + '/recheck', headers: { cookie }
  });
  assert.equal(recheck.statusCode, 503, recheck.body);
  assert.equal(recheck.json().diagnosticCode, 'TLS_FAILURE', recheck.body);
  assert.equal(recheck.body.includes(fakeSavedToken), false);
  assert.deepEqual(Object.keys(recheck.json()).sort(), ['diagnosticCode','diagnosticId','error']);

  scenario = 'unhandled-echo';
  const unexpected = await app.inject({
    method: 'POST', url: '/api/accounts/' + savedId + '/recheck', headers: { cookie }
  });
  assert.equal(unexpected.statusCode, 500, unexpected.body);
  assert.equal(unexpected.json().diagnosticCode, 'SERVER_ERROR');
  assert.equal(unexpected.body.includes(fakeSavedToken), false);

  scenario = 'vk-ip-echo';
  const activated = await app.inject({
    method: 'POST', url: '/api/accounts/' + vkId + '/activate', headers: { cookie }
  });
  assert.equal(activated.statusCode, 400, activated.body);
  assert.equal(activated.json().diagnosticCode, 'IP_RESTRICTED', activated.body);
  assert.equal(activated.body.includes(fakeVkToken), false);
  assert.equal(db.prepare('SELECT enabled FROM social_accounts WHERE id=?').get(vkId).enabled, 0);

  scenario = 'max-permission-echo';
  const maxDenied = await app.inject({
    method: 'POST', url: '/api/accounts/test', headers: { cookie },
    payload: { platform: 'max', credentials: { accessToken: fakeMaxToken, chatId: '-100777' } }
  });
  assert.equal(maxDenied.statusCode, 400, maxDenied.body);
  assert.equal(maxDenied.json().diagnosticCode, 'PERMISSIONS_DENIED', maxDenied.body);
  assert.equal(maxDenied.body.includes(fakeMaxToken), false);

  const classifications = [
    ['dns-failure', 'DNS_UNAVAILABLE'],
    ['tls-failure', 'TLS_FAILURE'],
    ['timeout-failure', 'TIMEOUT'],
    ['tcp-failure', 'TRANSPORT_UNAVAILABLE'],
    ['permission-failure', 'PERMISSIONS_DENIED'],
    ['rejected-failure', 'CREDENTIAL_REJECTED'],
    ['destination-failure', 'DESTINATION_NOT_CONFIRMED']
  ];
  for (const [mode, expectedCode] of classifications) {
    scenario = mode;
    const response = await app.inject({
      method: 'POST', url: '/api/accounts/test', headers: { cookie },
      payload: { platform: 'telegram', credentials: { botToken: fakeToken, chatId: '@fixture_channel' } }
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().diagnosticCode, expectedCode, response.body);
    assert.equal(response.body.includes(fakeToken), false);
  }

  // An OAuth one-time result ticket is intentionally never included in access logs.
  const oauth = await app.inject({
    method: 'GET', url: '/api/vk/oauth/result?ticket=' + encodeURIComponent(fakeSavedToken),
    headers: { cookie }
  });
  assert.equal(oauth.statusCode, 404, oauth.body);
  assert.equal(oauth.body.includes(fakeSavedToken), false);

  scenario = 'saved-success-echo';
  const storedSuccess = await app.inject({
    method: 'POST', url: '/api/accounts/' + savedId + '/test', headers: { cookie }
  });
  assert.equal(storedSuccess.statusCode, 200, storedSuccess.body);
  assert.equal(storedSuccess.body.includes(fakeSavedToken), false,
    'success response must redact stored token echoed by the provider');
  assert.ok(storedSuccess.body.includes('[скрыто]'), storedSuccess.body);

  scenario = 'success';
  const successful = await app.inject({
    method: 'POST',
    url: '/api/accounts/test',
    headers: { cookie },
    payload: { platform: 'telegram', credentials: { botToken: fakeToken, chatId: '@fixture_channel' } }
  });
  assert.equal(successful.statusCode, 200, successful.body);
  assert.equal(successful.json().identity, '@fixture_diagnostic_bot');

  const rows = db.prepare(`SELECT event_type, message, data_json, created_at
    FROM publication_events WHERE event_type LIKE 'social_connection_attempt_%'
    ORDER BY created_at`).all();
  assert.ok(rows.length >= 17, JSON.stringify(rows));
  for (const row of rows) {
    assert.equal(JSON.stringify(row).includes(fakeToken), false);
    assert.equal(JSON.stringify(row).includes(fakeMaxToken), false);
    assert.equal(JSON.stringify(row).includes(fakeSavedToken), false);
    assert.equal(JSON.stringify(row).includes(fakeVkToken), false);
    const data = JSON.parse(row.data_json);
    assert.ok(data.diagnosticId.startsWith('socialcheck_'));
    assert.ok(['telegram', 'max', 'vk'].includes(data.platform));
    assert.ok(data.operation && data.route && data.code);
    assert.ok(Number.isInteger(data.status));
    assert.ok(typeof data.diagnosticId === 'string');
    assert.ok(row.message.includes(data.diagnosticId), 'journal must display safe diagnostic ID');
    assert.ok(typeof row.created_at === 'string');
    assert.equal(Object.hasOwn(data, 'credentials'), false);
    assert.equal(Object.hasOwn(data, 'providerPayload'), false);
  }
  assert.ok(rows.some(row => JSON.parse(row.data_json).diagnosticId === failedBody.diagnosticId));
  assert.ok(rows.some(row => row.event_type === 'social_connection_attempt_succeeded'));

  scenario = 'echo-error';
  await app.listen({ host: '127.0.0.1', port: 18107 });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('http://127.0.0.1:18107/socials');
  await page.locator('#password').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('.operator-add-platform[data-platform="telegram"]').click();
  const form = page.locator('#operator-social-form');
  await form.locator('input[name="name"]').fill('Diagnostic test');
  await form.locator('input[name="botToken"]').fill(fakeToken);
  await form.locator('input[name="chatId"]').fill('@fixture_channel');
  await form.locator('#operator-test-connect').click();
  const alert = form.locator('#operator-connect-result [role="alert"]');
  await alert.waitFor();
  const shown = await alert.textContent();
  assert.match(shown, /PROVIDER_UNAVAILABLE/);
  assert.match(shown, /socialcheck_/);
  assert.match(shown, /Копировать диагностику без ключей/);
  assert.equal(shown.includes(fakeToken), false, 'the DOM must not repeat credential in errors');

  // The dialog can close; the saved account still offers a non-secret
  // diagnostic for the same encrypted key without resubmitting credentials.
  await page.locator('#operator-close-connect').click();
  scenario = 'saved-echo-error';
  const row = page.locator('.operator-connection[data-account-id="' + savedId + '"]');
  await row.locator('.operator-test-account').click();
  const savedAlert = row.locator('.operator-account-result [role="alert"]');
  await savedAlert.waitFor();
  const savedShown = await savedAlert.textContent();
  assert.match(savedShown, /PROVIDER_UNAVAILABLE/);
  assert.match(savedShown, /socialcheck_/);
  assert.equal(savedShown.includes(fakeSavedToken), false);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await savedAlert.locator('.operator-copy-social-diagnostic').click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /ID диагностики:/);
  assert.equal(copied.includes(fakeSavedToken), false);

  await page.setViewportSize({ width: 390, height: 844 });
  await savedAlert.scrollIntoViewIfNeeded();
  assert.equal(await savedAlert.isVisible(), true, 'saved-key error must be visible on mobile');

  const visibleDiagnosticId = savedShown.match(/socialcheck_[0-9a-f-]+/)?.[0];
  assert.ok(visibleDiagnosticId);
  await page.goto('http://127.0.0.1:18107/journal', { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction((diagnosticId) =>
    (document.querySelector('#view')?.textContent || '').includes(diagnosticId), visibleDiagnosticId);
  assert.ok((await page.locator('#view').innerText()).includes(visibleDiagnosticId),
    'the built-in Journal must show the saved-key diagnostic after the connection form closes');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(publicWrites, 0, 'diagnostic check must never create a public post');
  assert.ok(safeCalls.every(host => ['api.telegram.org', 'api.vk.com', 'platform-api2.max.ru'].includes(host)));
  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'SOCIAL-ERROR-VISIBILITY-001',
    classifiedMissingFields: true,
    classifiedNetworkFailure: true,
    providerEchoRedacted: true,
    savedCredentialEchoRedacted: true,
    savedVkIpRestrictionClassified: true,
    maxPermissionsClassified: true,
    recheckUnexpectedExceptionSafe: true,
    providerFailureMatrix: true,
    successPayloadRedaction: true,
    persistedNonSecretAudit: true,
    browserDiagnosticCodeAndId: true,
    savedKeyBrowserAndClipboardSafe: true,
    mobileDiagnosticVisible: true,
    journalLookupByDiagnosticId: true,
    publicWrites: 0,
    browserErrors: 0
  }));
} finally {
  await browser?.close();
  globalThis.fetch = originalFetch;
  await app.close();
  db.close();

  if (persistedDiagnosticId) {
    // A fresh Node process must read the saved diagnostic from SQLite after
    // the original app/logger and DB connection are closed.
    const script = [
      "const assert=require('node:assert/strict')",
      "const path=require('node:path')",
      "const Database=require('better-sqlite3')",
      "const d=new Database(path.join(process.env.DATA_DIR,'publikator.sqlite'),{readonly:true,fileMustExist:true})",
      "const events=d.prepare(\"SELECT event_type,data_json FROM publication_events WHERE event_type LIKE 'social_connection_attempt_%'\").all()",
      "const found=events.find(row=>JSON.parse(row.data_json).diagnosticId===process.env.SAVED_DIAGNOSTIC_ID)",
      "assert.ok(found,'persisted diagnostic ID not recovered in fresh process')",
      "assert.equal(JSON.parse(found.data_json).platform,'telegram')",
      "assert.ok(events.length>=17)",
      "const accounts=d.prepare(\"SELECT platform,enabled,credentials_encrypted FROM social_accounts\").all()",
      "assert.equal(accounts.length,2)",
      "assert.ok(accounts.every(row=>row.enabled===0 && row.credentials_encrypted.startsWith('v1:')))",
      "d.close()",
      "console.log(JSON.stringify({persisted:true,eventCount:events.length,encryptedAccounts:accounts.length}))"
    ].join(';');
    const reopened = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: dataDir, SAVED_DIAGNOSTIC_ID: persistedDiagnosticId },
      encoding: 'utf8',
      timeout: 20000
    });
    assert.equal(reopened.status, 0, 'diagnostic and encryption persistence failed after process restart');
    assert.match(reopened.stdout, /"persisted":true/);
  }
  await fs.rm(dataDir, { recursive: true, force: true });
}
