import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-group-text-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: dataDir, ADMIN_PASSWORD: 'group-text-password',
  APP_MASTER_KEY: 'group-text-master-key-longer-than-thirty-two-characters'
});
const { db, migrate } = await import('../dist/db.js');
const { decryptJson, encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
const { vkPublisher } = await import('../dist/platforms/vk.js');
const { inspectSocialCredential } = await import('../dist/platforms/credential-inspection.js');
const { readCapabilityProfile } = await import('../dist/social-credential-capability.js');
migrate();
const app = await buildApp();
await app.ready();
const originalFetch = globalThis.fetch;
const calls = [];
let wallAllowed = true;
let responseLost = false;
globalThis.fetch = async (input, init = {}) => {
  const method = /\/method\/([^/?]+)/.exec(String(input))?.[1];
  const body = new URLSearchParams(String(init.body || ''));
  calls.push({ method, owner: body.get('owner_id'), group: body.get('group_id') });
  const token = body.get('access_token');
  if (method === 'groups.getTokenPermissions') return Response.json({
    response: { permissions: wallAllowed && token !== 'limited-key' ? [{ name: 'wall' }] : [{ name: 'messages' }] }
  });
  if (method === 'groups.getById') {
    assert.equal(body.has('group_id'), false, 'selected-object readability must not masquerade as token binding');
    return Response.json({ response: { groups: [{ id: 67890, name: 'Bound community', screen_name: 'bound' }] } });
  }
  if (method === 'wall.post') {
    assert.equal(body.get('owner_id'), '-67890');
    assert.equal(body.get('from_group'), '1');
    assert.equal(body.get('attachments'), '');
    assert.ok(body.get('message').trim());
    assert.ok(body.get('guid').endsWith(':-67890'));
    if (responseLost) throw new TypeError('response lost');
    return Response.json({ response: { post_id: 4321 } });
  }
  throw new Error('Unexpected provider method ' + method);
};
try {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const req = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  const credentials = { authKind: 'COMMUNITY', destinationKind: 'COMMUNITY', groupId: '67890', accessToken: 'group-secret' };
  const mismatch = await req('POST', '/api/accounts', { platform: 'vk', name: 'Wrong community',
    credentials: { ...credentials, groupId: '99999', textPublishReady: true, tokenGroupId: '99999' } });
  assert.equal(mismatch.statusCode, 400, mismatch.body);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM social_accounts').get().n, 0);
  const saved = await req('POST', '/api/accounts', { platform: 'vk', name: 'Bound text', credentials });
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json().enabled, 1);
  const accountId = saved.json().id;
  const stored = decryptJson(db.prepare('SELECT credentials_encrypted FROM social_accounts WHERE id=?').get(accountId).credentials_encrypted);
  assert.equal(stored.textPublishReady, true);
  assert.equal(stored.tokenGroupId, '67890');
  const profile = readCapabilityProfile(accountId);
  assert.equal(profile.accessLevel, 'PARTIAL');
  assert.equal(profile.semantic.publicationReadiness.TEXT.state, 'READY');
  assert.equal(profile.semantic.publicationReadiness.IMAGE.state, 'SETUP_REQUIRED');
  assert.equal(profile.semantic.methods.find(x => x.method === 'wall.post').state, 'NOT_CHECKED');
  const listed = await req('GET', '/api/accounts');
  assert.equal(listed.body.includes('group-secret'), false);
  assert.equal(listed.json()[0].text_publish_ready, true);
  const inspected = await inspectSocialCredential('vk', credentials);
  assert.equal(inspected.publicationEvidence.TEXT.state, 'CONFIRMED');
  const foreign = await inspectSocialCredential('vk', { ...credentials, groupId: '99999' });
  assert.equal(foreign.destination.resolutionState, 'DENIED');
  assert.equal(foreign.publicationEvidence.TEXT.state, 'DENIED');
  const limited = await req('POST', '/api/accounts', { platform: 'vk', name: 'Limited',
    credentials: { ...credentials, accessToken: 'limited-key', textPublishReady: true } });
  assert.equal(limited.statusCode, 201, limited.body);
  assert.equal(limited.json().enabled, 0);
  const limitedId = limited.json().id;
  assert.equal((await req('PATCH', '/api/accounts/' + limitedId, { enabled: true })).statusCode, 409);
  assert.equal(calls.some(x => x.method === 'wall.post'), false, 'save/check/enable must never publish');

  const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
  async function textPost(title) {
    const created = await req('POST', '/api/posts', { projectId, title, body: 'Community text acceptance', scheduleMode: 'MANUAL', contentFormat: 'TEXT_ONLY' });
    assert.equal(created.statusCode, 201, created.body);
    const post = created.json();
    assert.equal(post.content_format, 'TEXT_ONLY');
    const ready = await req('POST', '/api/posts/' + post.id + '/ready', { expectedContentVersion: post.content_version });
    assert.equal(ready.statusCode, 200, ready.body);
    return post;
  }
  const input = { postId: 'direct', title: 'x', text: 'x', media: [], publicMediaUrls: [], credentials: stored,
    publicationKind: 'FEED', contentFormat: 'TEXT_ONLY' };
  vkPublisher.validate(input);
  assert.throws(() => vkPublisher.validate({ ...input, contentFormat: 'IMAGE' }), /пользовательский ключ/);
  assert.throws(() => vkPublisher.validate({ ...input, credentials: { ...stored, groupId: '99999' } }), /не совпадает/);
  const changedFormat = await textPost('READY format change');
  const changed = await req('PATCH', '/api/posts/' + changedFormat.id, {
    contentFormat: 'MEDIA', expectedContentVersion: changedFormat.content_version
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().post.status, 'DRAFT', 'format changes must invalidate READY');
  assert.equal(changed.json().post.content_format, 'IMAGE');
  assert.ok(changed.json().contentVersion > changedFormat.content_version);
  const staleReady = await req('POST', '/api/posts/' + changedFormat.id + '/ready', {
    expectedContentVersion: changedFormat.content_version
  });
  assert.equal(staleReady.statusCode, 409, staleReady.body);
  assert.equal(calls.some(x => x.method === 'wall.post'), false);
  const successful = await textPost('Text succeeds');
  const published = await req('POST', '/api/posts/' + successful.id + '/publish-now');
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().post.status, 'PUBLISHED');
  assert.equal(calls.filter(x => x.method === 'wall.post').length, 1);
  assert.ok(published.body.includes('https://vk.com/wall-67890_4321'));
  await req('POST', '/api/posts/' + successful.id + '/publish-now');
  assert.equal(calls.filter(x => x.method === 'wall.post').length, 1, 'repeated publish must not duplicate');

  const revoked = await textPost('Rights revoked after READY');
  wallAllowed = false;
  await req('POST', '/api/posts/' + revoked.id + '/publish-now');
  assert.equal(calls.filter(x => x.method === 'wall.post').length, 1, 'revoke must block before public write');
  wallAllowed = true;
  const uncertain = await textPost('Unknown public result');
  responseLost = true;
  await req('POST', '/api/posts/' + uncertain.id + '/publish-now');
  assert.equal(db.prepare('SELECT state FROM post_targets WHERE post_id=? AND account_id=?').get(uncertain.id, accountId).state, 'RECOVERY_NEEDED');
  assert.equal(calls.filter(x => x.method === 'wall.post').length, 2);
  assert.equal(calls.some(x => String(x.method).startsWith('photos.')), false);

  // An old encrypted GROUP account can be enabled using only its stored secret.
  const legacy = { ...stored };
  delete legacy.textPublishReady;
  delete legacy.tokenGroupId;
  db.prepare('UPDATE social_accounts SET credentials_encrypted=?,enabled=0 WHERE id=?').run(encryptJson(legacy), accountId);
  const version = db.prepare('SELECT credential_version FROM social_accounts WHERE id=?').get(accountId).credential_version;
  const enabled = await req('PATCH', '/api/accounts/' + accountId, { enabled: true });
  assert.equal(enabled.statusCode, 200, enabled.body);
  const refreshedVersion = db.prepare('SELECT credential_version FROM social_accounts WHERE id=?').get(accountId).credential_version;
  assert.equal(refreshedVersion, version + 1, 'new verified credential semantics invalidate old profiles');
  await req('PATCH', '/api/accounts/' + accountId, { enabled: true });
  assert.equal(db.prepare('SELECT credential_version FROM social_accounts WHERE id=?').get(accountId).credential_version, refreshedVersion);
  console.log(JSON.stringify({ ok: true, checkpoint: 'VK-GROUP-TEXT-001', safeInspection: true,
    boundDestination: true, partialProfile: true, textReadyAndPublish: true, photoBlocked: true,
    noDuplicate: true, revokeBeforePublicWrite: true, unknownResultRecovery: true }));
} finally {
  globalThis.fetch = originalFetch;
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
