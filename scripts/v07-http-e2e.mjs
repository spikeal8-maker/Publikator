import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-v07-http-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'http-e2e-password';
process.env.APP_MASTER_KEY = 'http-e2e-master-key-that-is-definitely-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';
process.env.EVENT_RETENTION_DAYS = '0';
process.env.BACKUP_RETENTION_COUNT = '0';

const sharp = (await import('sharp')).default;
const { db, migrate } = await import('../dist/db.js');
const { PlatformError } = await import('../dist/platforms/types.js');
const { setPublisherForTests } = await import('../dist/platforms/index.js');

let mode = 'success';
let calls = 0;
setPublisherForTests('telegram', {
  platform: 'telegram',
  validate(input) {
    if (!input.media.length) throw new Error('Mock requires media');
    if (!input.text.trim()) throw new Error('Mock requires text');
  },
  async publish() {
    calls += 1;
    if (mode === 'unknown') throw new PlatformError('HTTP E2E unknown outcome', { outcomeUnknown: true });
    return { externalId: `http-mock-${calls}`, externalUrl: `https://example.test/http/${calls}` };
  }
});

migrate();
const { buildApp } = await import('../dist/app.js');
const app = await buildApp();
const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
let cookie = '';

async function request(route, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('cookie', cookie);
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${baseUrl}${route}`, { ...options, headers });
}

async function json(route, options = {}, expectedStatus = 200) {
  const response = await request(route, options);
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${route}: ${JSON.stringify(payload)}`);
  return payload;
}

async function uploadImage(postId, name = 'http-e2e.png') {
  const bytes = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 120, g: 60, b: 200 } }
  }).png().toBuffer();
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'image/png' }), name);
  const response = await request(`/api/posts/${postId}/media`, { method: 'POST', body: form });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 201, `media upload: ${JSON.stringify(payload)}`);
  return payload;
}

try {
  const unauthenticatedDiagnostics = await fetch(`${baseUrl}/api/diagnostics`);
  assert.equal(unauthenticatedDiagnostics.status, 401);

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'http-e2e-password' })
  });
  assert.equal(loginResponse.status, 200);
  const setCookie = loginResponse.headers.get('set-cookie');
  assert.ok(setCookie?.startsWith('publikator_session='));
  cookie = setCookie.split(';')[0];

  const project = await json('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'HTTP E2E Project', slug: 'http-e2e-project' })
  }, 201);
  assert.equal(project.slug, 'http-e2e-project');

  const account = await json('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({
      platform: 'telegram',
      name: 'HTTP Mock Telegram',
      credentials: { botToken: 'mock-token', chatId: '@mock-http' }
    })
  }, 201);
  assert.equal(account.platform, 'telegram');

  const post = await json('/api/posts', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      title: 'HTTP draft',
      body: 'Original body',
      scheduleMode: 'MANUAL'
    })
  }, 201);
  assert.equal(post.status, 'DRAFT');

  await json(`/api/posts/${post.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'HTTP edited', body: 'Edited body' })
  });
  const edited = await json(`/api/posts/${post.id}`);
  assert.equal(edited.title, 'HTTP edited');
  assert.equal(edited.body, 'Edited body');

  const media = await uploadImage(post.id);
  assert.ok(media.id);
  await json(`/api/posts/${post.id}/targets`, {
    method: 'PUT',
    body: JSON.stringify({ accountIds: [account.id] })
  });
  await json(`/api/posts/${post.id}/ready`, { method: 'POST' });
  mode = 'success';
  const beforePublish = calls;
  const published = await json(`/api/posts/${post.id}/publish-now`, { method: 'POST' });
  assert.equal(calls, beforePublish + 1);
  assert.equal(published.post.status, 'PUBLISHED');
  assert.ok(published.post.targets.some((target) => target.account_id === account.id && target.state === 'PUBLISHED'));

  const immutablePatch = await json(`/api/posts/${post.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'Must fail' })
  }, 409);
  assert.match(immutablePatch.error, /Нельзя редактировать/);

  const recoveryPost = await json('/api/posts', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      title: 'HTTP recovery',
      body: 'Unknown outcome path',
      scheduleMode: 'MANUAL'
    })
  }, 201);
  await uploadImage(recoveryPost.id, 'recovery.png');
  await json(`/api/posts/${recoveryPost.id}/targets`, {
    method: 'PUT',
    body: JSON.stringify({ accountIds: [account.id] })
  });
  await json(`/api/posts/${recoveryPost.id}/ready`, { method: 'POST' });
  mode = 'unknown';
  const beforeUnknown = calls;
  const recoveryPublish = await json(`/api/posts/${recoveryPost.id}/publish-now`, { method: 'POST' });
  assert.equal(calls, beforeUnknown + 1);
  const recoveryTarget = recoveryPublish.post.targets.find((target) => target.account_id === account.id);
  assert.equal(recoveryTarget.state, 'RECOVERY_NEEDED');

  const beforeBlockedRetry = calls;
  const blockedRetry = await json(`/api/targets/${recoveryTarget.id}/retry`, { method: 'POST' }, 409);
  assert.match(blockedRetry.error, /RECOVERY_NEEDED|вручную/i);
  assert.equal(calls, beforeBlockedRetry, 'generic retry must not call publisher from RECOVERY_NEEDED');

  await json(`/api/targets/${recoveryTarget.id}/recovery/confirm-not-published`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  const resolvedAbsent = await json(`/api/posts/${recoveryPost.id}`);
  assert.equal(resolvedAbsent.targets.find((target) => target.id === recoveryTarget.id).state, 'FAILED');
  mode = 'success';
  await json(`/api/targets/${recoveryTarget.id}/retry`, { method: 'POST' });
  const recoveryRetried = await json(`/api/posts/${recoveryPost.id}`);
  assert.equal(recoveryRetried.targets.find((target) => target.id === recoveryTarget.id).state, 'PUBLISHED');

  const manualRecoveryPost = await json('/api/posts', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      title: 'HTTP manual published recovery',
      body: 'Manual found path',
      scheduleMode: 'MANUAL'
    })
  }, 201);
  await uploadImage(manualRecoveryPost.id, 'manual-recovery.png');
  await json(`/api/posts/${manualRecoveryPost.id}/targets`, {
    method: 'PUT',
    body: JSON.stringify({ accountIds: [account.id] })
  });
  await json(`/api/posts/${manualRecoveryPost.id}/ready`, { method: 'POST' });
  mode = 'unknown';
  const manualRecoveryPublish = await json(`/api/posts/${manualRecoveryPost.id}/publish-now`, { method: 'POST' });
  const manualRecoveryTarget = manualRecoveryPublish.post.targets.find((target) => target.account_id === account.id);
  assert.equal(manualRecoveryTarget.state, 'RECOVERY_NEEDED');
  const beforeManualConfirm = calls;
  await json(`/api/targets/${manualRecoveryTarget.id}/recovery/confirm-published`, {
    method: 'POST',
    body: JSON.stringify({
      externalId: 'operator-confirmed-id',
      externalUrl: 'https://example.test/operator-confirmed-id'
    })
  });
  assert.equal(calls, beforeManualConfirm, 'manual confirm published must not call publisher');
  const manualResolved = await json(`/api/posts/${manualRecoveryPost.id}`);
  const manualResolvedTarget = manualResolved.targets.find((target) => target.id === manualRecoveryTarget.id);
  assert.equal(manualResolvedTarget.state, 'PUBLISHED');
  assert.equal(manualResolvedTarget.external_id, 'operator-confirmed-id');

  const removablePost = await json('/api/posts', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      title: 'Removable media',
      body: 'Media delete CRUD',
      scheduleMode: 'MANUAL'
    })
  }, 201);
  const removableMedia = await uploadImage(removablePost.id, 'remove-me.png');
  await json(`/api/media/${removableMedia.id}`, { method: 'DELETE' });
  const removableAfter = await json(`/api/posts/${removablePost.id}`);
  assert.equal(removableAfter.media.length, 0);

  const weekday = new Date().getDay();
  const slot = await json('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, weekday, time: '23:59', timezone: 'Europe/Moscow' })
  }, 201);
  assert.equal(slot.project_id, project.id);
  const schedules = await json('/api/schedules');
  assert.ok(schedules.some((item) => item.id === slot.id));
  await json(`/api/schedules/${slot.id}`, { method: 'DELETE' });

  const diagnostics = await json('/api/diagnostics');
  assert.equal(String(diagnostics.database.quickCheck).toLowerCase(), 'ok');
  assert.equal(diagnostics.media.missingFiles, 0);
  assert.equal(diagnostics.recovery.pendingTargets, 0);
  assert.equal(diagnostics.retention.eventRetentionDays, 0);
  assert.equal(diagnostics.retention.backupRetentionCount, 0);

  const events = await json('/api/events?limit=200');
  assert.ok(events.some((item) => item.event_type === 'publish_recovery_confirmed_absent'));
  assert.ok(events.some((item) => item.event_type === 'publish_recovery_confirmed_published'));

  const projects = await json('/api/projects');
  assert.ok(projects.some((item) => item.id === project.id));

  console.log(JSON.stringify({ ok: true, publisherCalls: calls, projectId: project.id, diagnosticsSeverity: diagnostics.severity }, null, 2));
} finally {
  setPublisherForTests('telegram', null);
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
