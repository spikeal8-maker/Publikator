import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-005-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cx3-005-ci-password';
process.env.APP_MASTER_KEY = 'cx3-005-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
const rich = await import('../dist/rich-media.js');
const delivery = await import('../dist/delivery-foundation.js');
const capabilities = await import('../dist/platforms/capabilities.js');
const { commitContentEdit, snapshotContentRevision, markReadyRevision } = await import('../dist/content-versioning.js');
const { preflightRevision, publishPost } = await import('../dist/publisher.js');
const { setPublisherForTests } = await import('../dist/platforms/index.js');

migrate();
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const accountId = id('acc');
const accountNow = nowIso();
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`)
  .run(accountId, 'telegram', 'CX3-005 Telegram', encryptJson({ botToken: 'mock-token', chatId: '@mock' }), accountNow, accountNow);

const app = await buildApp();
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];

async function request(method, url, payload) {
  return app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
}

async function createPost(title, body = `${title} body`) {
  const response = await request('POST', '/api/posts', { projectId, title, body, scheduleMode: 'MANUAL' });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

function addMedia(postId, expectedContentVersion, name, mimeType, width, height, order = 0) {
  const mediaId = id('med');
  const committed = commitContentEdit(postId, expectedContentVersion, 'manual', () => {
    db.prepare(`INSERT INTO media
      (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(mediaId, postId, name, `${postId}/${name}`, mimeType, 1024, width, height,
        String(order + 1).repeat(64).slice(0, 64), nowIso(), order);
    return mediaId;
  });
  return { mediaId, contentVersion: committed.contentVersion };
}

const anonymousCapabilities = await app.inject({ method: 'GET', url: '/api/platform-capabilities' });
assert.equal(anonymousCapabilities.statusCode, 401, anonymousCapabilities.body);
const capabilityResponse = await request('GET', '/api/platform-capabilities');
assert.equal(capabilityResponse.statusCode, 200, capabilityResponse.body);
const capabilityBody = capabilityResponse.json();
assert.equal(capabilityBody.version, 1);
assert.equal(capabilityBody.capabilities.length, 4);
const telegramCapability = capabilityBody.capabilities.find((item) => item.platform === 'telegram');
assert.equal(telegramCapability.supportsFeed, true);
assert.equal(telegramCapability.supportsImage, true);
assert.equal(telegramCapability.supportsCarousel, true);
assert.equal(telegramCapability.supportsVideo, false);
assert.equal(telegramCapability.supportsStories, false);
assert.equal(telegramCapability.supportsShortVideo, false);
assert.equal(telegramCapability.maxMediaPerPublication, 10);

const fakeImage = {
  id: 'med_fake', post_id: 'post_fake', original_name: 'too-wide.jpg', relative_path: 'x/y.jpg',
  mime_type: 'image/jpeg', size_bytes: 1024, width: 10001, height: 1, sha256: 'a'.repeat(64), created_at: nowIso(), sort_order: 0
};
const directIssues = capabilities.capabilityIssues('telegram', {
  postId: 'post_fake', title: 'x', text: 'x'.repeat(4097), media: [fakeImage], credentials: {}, publicMediaUrls: [],
  publicationKind: 'FEED', contentFormat: 'IMAGE'
});
assert.ok(directIssues.some((issue) => issue.code === 'TEXT_TOO_LONG'));
assert.ok(directIssues.some((issue) => issue.code === 'ASPECT_RATIO_LIMIT'));
assert.ok(directIssues.some((issue) => issue.code === 'DIMENSION_SUM_LIMIT'));
const maxUrlIssues = capabilities.capabilityIssues('max', {
  postId: 'post_fake', title: 'x', text: 'ok', media: [{ ...fakeImage, width: 1000, height: 1000 }], credentials: {}, publicMediaUrls: [],
  publicationKind: 'FEED', contentFormat: 'IMAGE'
});
assert.ok(maxUrlIssues.some((issue) => issue.code === 'PUBLIC_MEDIA_URL_REQUIRED'));

const supported = await createPost('Supported feed image');
const supportedMedia = addMedia(supported.id, supported.content_version, 'image.jpg', 'image/jpeg', 1200, 1200);
const readySupported = await request('POST', `/api/posts/${supported.id}/ready`, { expectedContentVersion: supportedMedia.contentVersion });
assert.equal(readySupported.statusCode, 200, readySupported.body);
assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(supported.id).status, 'READY');

const shortPost = await createPost('Unsupported short video');
const shortMedia = addMedia(shortPost.id, shortPost.content_version, 'clip.mp4', 'video/mp4', 1080, 1920);
const videoId = shortMedia.mediaId;
const metadataEdit = rich.setVideoMetadataVersioned(videoId, shortMedia.contentVersion, {
  durationMs: 5000, fps: 30, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4'
});
const compositionEdit = rich.setContentCompositionVersioned(shortPost.id, metadataEdit.contentVersion, 'SHORT', 'VERTICAL_VIDEO', [
  { mediaId: videoId, role: 'video' }
]);
const blockedReady = await request('POST', `/api/posts/${shortPost.id}/ready`, { expectedContentVersion: compositionEdit.contentVersion });
assert.equal(blockedReady.statusCode, 409, blockedReady.body);
assert.ok(blockedReady.json().issues.some((issue) => issue.code === 'UNSUPPORTED_COMPOSITION'));
let shortRow = db.prepare('SELECT status,ready_revision_id FROM posts WHERE id=?').get(shortPost.id);
assert.equal(shortRow.status, 'DRAFT');
assert.equal(shortRow.ready_revision_id, null);

const shortRevision = snapshotContentRevision(shortPost.id, compositionEdit.contentVersion, 'cx3-005-forced-ready');
markReadyRevision(shortPost.id, compositionEdit.contentVersion, shortRevision.id);
let externalPostCalls = 0;
setPublisherForTests('telegram', {
  platform: 'telegram',
  validate() {},
  async publish() { externalPostCalls += 1; return { externalId: 'should-not-publish' }; }
});
await assert.rejects(() => publishPost(shortPost.id), /preflight/i);
assert.equal(externalPostCalls, 0, 'capability must block before external publisher call');
setPublisherForTests('telegram', null);

const renditionPost = await createPost('Target rendition compatibility');
const renditionMedia = addMedia(renditionPost.id, renditionPost.content_version, 'story-source.jpg', 'image/jpeg', 1080, 1920);
const targetId = db.prepare('SELECT id FROM post_targets WHERE post_id=? AND account_id=?').get(renditionPost.id, accountId).id;
const renditionEdit = delivery.saveTargetRendition(targetId, {
  textPlain: 'Target-specific story text', publicationKind: 'STORY', contentFormat: 'IMAGE'
}, renditionMedia.contentVersion);
const renditionRevision = snapshotContentRevision(renditionPost.id, renditionEdit.contentVersion, 'cx3-005-rendition');
const renditionPreflight = preflightRevision(renditionRevision.id);
assert.equal(renditionPreflight.ok, false);
assert.ok(renditionPreflight.issues.some((issue) => issue.code === 'UNSUPPORTED_COMPOSITION'));
assert.ok(renditionPreflight.issues.some((issue) => issue.message.includes('STORY/IMAGE')));

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-005',
  schemaVersion: Number(db.pragma('user_version', { simple: true })),
  capabilityApi: true,
  singleSourceRules: true,
  supportedFeedImageReady: true,
  unsupportedShortBlockedAtReady: true,
  publisherDefenseInDepth: true,
  targetRenditionResolvedBeforePreflight: true,
  telegramTextAndAspectRules: true,
  publicHttpsRule: true
}, null, 2));

await app.close();
db.close();
await fs.rm(dataDir, { recursive: true, force: true });
