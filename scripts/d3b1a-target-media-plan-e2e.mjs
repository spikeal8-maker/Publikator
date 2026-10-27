import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-d3b1a-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'd3b1a-test-password-not-for-production';
process.env.APP_MASTER_KEY = 'd3b1a-test-master-key-36-characters-long';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
const rich = await import('../dist/rich-media.js');
const { getContentRevision, revisionTargets } = await import('../dist/content-versioning.js');
const { buildRevisionPublishInput, publishPost } = await import('../dist/publisher.js');
const { setPublisherForTests } = await import('../dist/platforms/index.js');

migrate();
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const accounts = [
  { id: 'acc_tg_one', name: 'Telegram One', platform: 'telegram' },
  { id: 'acc_tg_two', name: 'Telegram Two', platform: 'telegram' },
  { id: 'acc_vk', name: 'VK School', platform: 'vk' }
];
for (const account of accounts) {
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES(?,?,?,?,1,?,?)`)
    .run(account.id, account.platform, account.name,
      encryptJson(account.platform === 'vk'
        ? { accessToken: 'fake-vk-user-key', authKind: 'USER', groupId: '1234' }
        : { botToken: 'fake-token', chatId: '@fake_school' }),
      nowIso(), nowIso());
  db.prepare('INSERT INTO project_default_targets(project_id,account_id,created_at) VALUES(?,?,?)')
    .run(projectId, account.id, nowIso());
}

const app = await buildApp();
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/auth/login',
  payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];
const request = (method, url, payload) => app.inject({
  method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload })
});
const anonymous = await app.inject({ method: 'PATCH', url: '/api/posts/no/targets/no/media-plan',
  payload: { mediaIds: [], expectedContentVersion: 1 } });
assert.equal(anonymous.statusCode, 401, 'new media plan endpoint must require authentication');

const created = await request('POST', '/api/posts', {
  projectId, title: 'Target Media Plan', body: 'Canonical school message', scheduleMode: 'MANUAL'
});
assert.equal(created.statusCode, 201, created.body);
const post = created.json();
const photos = [];
for (let i = 0; i < 3; i += 1) {
  const mediaId = id('med');
  photos.push(mediaId);
  db.prepare(`INSERT INTO media(id,post_id,original_name,relative_path,mime_type,
    size_bytes,width,height,sha256,created_at,sort_order)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mediaId, post.id, `picture-${i}.jpg`, `${post.id}/picture-${i}.jpg`,
      'image/jpeg', 1024, 1024, 1024, String(i + 1).repeat(64).slice(0, 64),
      nowIso(), i);
}
const composed = rich.setContentCompositionVersioned(
  post.id, post.content_version, 'FEED', 'CAROUSEL',
  photos.map((mediaId) => ({ mediaId, role: 'carousel_item' }))
);
let version = composed.contentVersion;
const rows = db.prepare('SELECT id,account_id FROM post_targets WHERE post_id=?')
  .all(post.id);
const target = (accountId) => rows.find((row) => row.account_id === accountId).id;
const tgOne = target('acc_tg_one');
const tgTwo = target('acc_tg_two');
const vk = target('acc_vk');

const caption = await request('PATCH', `/api/posts/${post.id}/targets/${vk}/text`, {
  text: 'VK school only', expectedContentVersion: version
});
assert.equal(caption.statusCode, 200, caption.body);
version = caption.json().contentVersion;

const setPlan = async (targetId, mediaIds, expectedVersion = version, postId = post.id) =>
  request('PATCH', `/api/posts/${postId}/targets/${targetId}/media-plan`, {
    mediaIds, expectedContentVersion: expectedVersion
  });

const invalidDuplicate = await setPlan(tgOne, [photos[0], photos[0]]);
assert.equal(invalidDuplicate.statusCode, 400);
assert.match(invalidDuplicate.json().error, /уникальные/i);
const invalidUnknown = await setPlan(tgOne, ['med_from_unrelated_post']);
assert.equal(invalidUnknown.statusCode, 400);
assert.match(invalidUnknown.json().error, /не принадлежит/i);
const invalidEmpty = await setPlan(tgOne, []);
assert.equal(invalidEmpty.statusCode, 400);
const invalidOtherPost = await setPlan(vk, [photos[0]], version, 'post_elsewhere');
assert.equal(invalidOtherPost.statusCode, 404);
const unexpectedField = await request('PATCH', `/api/posts/${post.id}/targets/${tgOne}/media-plan`, {
  mediaIds: { arbitrary: true }, expectedContentVersion: version
});
assert.equal(unexpectedField.statusCode, 400);
assert.equal(db.prepare('SELECT content_version FROM posts WHERE id=?').get(post.id).content_version,
  version, 'rejected plans must never advance content versions');

const tgPlan = await setPlan(tgOne, [photos[2], photos[0]]);
assert.equal(tgPlan.statusCode, 200, tgPlan.body);
version = tgPlan.json().contentVersion;
assert.deepEqual(tgPlan.json().mediaIds, [photos[2], photos[0]]);
const staleVersion = await setPlan(vk, [photos[1]], version - 1);
assert.equal(staleVersion.statusCode, 409, 'stale content mutation may not silently win');
const vkPlan = await setPlan(vk, [photos[1]]);
assert.equal(vkPlan.statusCode, 200, vkPlan.body);
version = vkPlan.json().contentVersion;
assert.equal(db.prepare('SELECT override_text FROM post_targets WHERE id=?').get(vk).override_text,
  'VK school only', 'updating media plan must not erase individual text');

const preview = await request('GET', `/api/posts/${post.id}/platform-previews`);
assert.equal(preview.statusCode, 200, preview.body);
const previews = preview.json().previews;
const tg1 = previews.find((x) => x.accountId === 'acc_tg_one');
const tg2 = previews.find((x) => x.accountId === 'acc_tg_two');
const vkView = previews.find((x) => x.accountId === 'acc_vk');
assert.deepEqual(tg1.media.filter((x) => x.role !== 'poster').map((x) => x.id),
  [photos[2], photos[0]], 'Telegram One has own custom media order and exclusion');
assert.deepEqual(tg2.media.filter((x) => x.role !== 'poster').map((x) => x.id),
  photos, 'Telegram Two inherits all canonical media');
assert.deepEqual(vkView.media.filter((x) => x.role !== 'poster').map((x) => x.id),
  [photos[1]], 'VK account has only the selected image');
assert.equal(vkView.contentFormat, 'IMAGE', 'one selected target photo resolves to IMAGE');
assert.equal(tg1.contentFormat, 'CAROUSEL');
assert.equal(vkView.text, 'VK school only');
assert.ok(previews.every((x) => !x.issues.some((i) => i.code === 'MEDIA_PLAN_NOT_EXECUTED')));
assert.equal(db.prepare('SELECT content_format FROM posts WHERE id=?').get(post.id).content_format,
  'CAROUSEL', 'per-account image restriction cannot alter base publication format');

const published = [];
for (const platform of ['telegram', 'vk']) {
  setPublisherForTests(platform, {
    platform,
    validate(input) { assert.ok(['IMAGE', 'CAROUSEL'].includes(input.contentFormat)); },
    async publish(input) {
      published.push({ platform, mediaIds: input.media.map((m) => m.id), format: input.contentFormat,
        text: input.text, target: input.credentials.chatId ?? input.credentials.groupId });
      return { externalId: 'fake-' + published.length };
    }
  });
}
const ready = await request('POST', `/api/posts/${post.id}/ready`, {
  expectedContentVersion: version
});
assert.equal(ready.statusCode, 200, ready.body);
assert.equal(db.prepare('SELECT status FROM posts WHERE id=?').get(post.id).status, 'READY');
const revision = getContentRevision(ready.json().revisionId);
const readyTargets = revisionTargets(revision);
assert.deepEqual(
  JSON.parse(readyTargets.find((x) => x.accountId === 'acc_tg_one').rendition.mediaPlanJson),
  { version: 1, mediaIds: [photos[2], photos[0]] },
  'READY must snapshot the exact per-target order, independent of future edits'
);
const inputTarget = (targetId, platform) => db.prepare(`SELECT pt.*,a.platform,a.name AS account_name,
  a.enabled AS account_enabled,a.credentials_encrypted
  FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id WHERE pt.id=?`).get(targetId);
const frozenVkInput = buildRevisionPublishInput(inputTarget(vk), revision);
assert.deepEqual(frozenVkInput.media.map((x) => x.id), [photos[1]]);
assert.equal(frozenVkInput.contentFormat, 'IMAGE');
const frozenTGInput = buildRevisionPublishInput(inputTarget(tgOne), revision);
assert.deepEqual(frozenTGInput.media.map((x) => x.id), [photos[2], photos[0]]);

// Simulate mutable working-table drift outside the API. Immutable READY data,
// not the mutable target row, must control the actual published photo order.
db.prepare('UPDATE target_renditions SET media_plan_json=? WHERE target_id=?')
  .run(JSON.stringify({ version: 1, mediaIds: [photos[0], photos[1]] }), tgOne);
db.prepare('UPDATE media SET sort_order=99 WHERE id=?').run(photos[0]);
assert.deepEqual(buildRevisionPublishInput(inputTarget(tgOne), revision).media.map((x) => x.id),
  [photos[2], photos[0]], 'READY publisher input cannot consume mutable target/media data');
await publishPost(post.id);
assert.equal(published.length, 3, 'one publish per selected exact account');
assert.deepEqual(published.filter((x) => x.platform === 'telegram').map((x) => x.mediaIds)
  .some((ids) => ids.join(',') === [photos[2], photos[0]].join(',')), true);
assert.ok(published.some((x) => x.platform === 'telegram' &&
  x.mediaIds.join(',') === photos.join(',')), 'unmodified TG recipient inherits canonical order');
assert.ok(published.some((x) => x.platform === 'vk' && x.mediaIds.length === 1 &&
  x.mediaIds[0] === photos[1] && x.format === 'IMAGE' && x.text === 'VK school only'));
assert.equal(db.prepare("SELECT COUNT(*) n FROM post_targets WHERE post_id=? AND state='PUBLISHED'")
  .get(post.id).n, 3);
assert.equal(db.prepare("SELECT COUNT(*) n FROM post_targets WHERE post_id=? AND state='RECOVERY_NEEDED'")
  .get(post.id).n, 0);

// A poster is a stored image but NOT part of the publishable canonical
// composition: reject it at mutation time, without consuming the version.
const withPoster = await request('POST', '/api/posts', {
  projectId, title: 'Carousel with poster asset', body: 'Carousel body', scheduleMode: 'MANUAL'
});
assert.equal(withPoster.statusCode, 201, withPoster.body);
const posterPost = withPoster.json();
const posterMedia = [];
for (let i = 0; i < 3; i += 1) {
  const mediaId = id('med');
  posterMedia.push(mediaId);
  db.prepare(`INSERT INTO media(id,post_id,original_name,relative_path,mime_type,
    size_bytes,width,height,sha256,created_at,sort_order)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mediaId, posterPost.id, `poster-fixture-${i}.jpg`,
      `${posterPost.id}/poster-fixture-${i}.jpg`,
      'image/jpeg', 1024, 1000, 1000, String(i + 5).repeat(64).slice(0, 64),
      nowIso(), i);
}
const posterComposition = rich.setContentCompositionVersioned(
  posterPost.id, posterPost.content_version, 'FEED', 'CAROUSEL', [
    { mediaId: posterMedia[0], role: 'carousel_item' },
    { mediaId: posterMedia[1], role: 'carousel_item' },
    { mediaId: posterMedia[2], role: 'poster' }
  ]
);
const posterTarget = db.prepare('SELECT id FROM post_targets WHERE post_id=? AND account_id=?')
  .get(posterPost.id, 'acc_tg_one').id;
const invalidPoster = await setPlan(posterTarget, [posterMedia[2]], posterComposition.contentVersion, posterPost.id);
assert.equal(invalidPoster.statusCode, 400, invalidPoster.body);
assert.match(invalidPoster.json().error, /не принадлежит/i);
assert.equal(db.prepare('SELECT content_version FROM posts WHERE id=?').get(posterPost.id).content_version,
  posterComposition.contentVersion, 'poster rejection must leave version and READY state unchanged');
const validWithPoster = await setPlan(posterTarget,
  [posterMedia[1], posterMedia[0]], posterComposition.contentVersion, posterPost.id);
assert.equal(validWithPoster.statusCode, 200, validWithPoster.body);
const posterPreview = await request('GET', `/api/posts/${posterPost.id}/platform-previews`);
assert.equal(posterPreview.statusCode, 200, posterPreview.body);
const selectedMedia = posterPreview.json().previews.find((x) => x.accountId === 'acc_tg_one').media
  .filter((x) => x.role !== 'poster').map((x) => x.id);
assert.deepEqual(selectedMedia, [posterMedia[1], posterMedia[0]]);

// A post without images must not acquire a phantom image plan.
const textOnly = await request('POST', '/api/posts', {
  projectId, title: 'Text-only', body: 'No media', scheduleMode: 'MANUAL'
});
assert.equal(textOnly.statusCode, 201);
const textTarget = db.prepare('SELECT id FROM post_targets WHERE post_id=? LIMIT 1')
  .get(textOnly.json().id).id;
const invalidText = await setPlan(textTarget, [photos[0]], textOnly.json().content_version, textOnly.json().id);
assert.equal(invalidText.statusCode, 400);

setPublisherForTests('telegram', null);
setPublisherForTests('vk', null);
await app.close();
db.close();
await fs.rm(dataDir, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true, checkpoint: 'D3b1a',
  exactTargets: 3, distinctMediaPlans: 2,
  directApiPlanValidation: true,
  canonicalInheritance: true,
  snapshotImmutablePublisher: true,
  preflightConsistentWithPreview: true,
  providerPosts: 0
}));
