import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-006-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cx3-006-ci-password';
process.env.APP_MASTER_KEY = 'cx3-006-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');
const rich = await import('../dist/rich-media.js');
const delivery = await import('../dist/delivery-foundation.js');

migrate();
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const createdAt = nowIso();
for (const platform of ['telegram', 'instagram']) {
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`).run(`acc_${platform}`, platform, `${platform} preview`, encryptJson({ token: 'mock' }), createdAt, createdAt);
}

const app = await buildApp();
await app.ready();
const anonymous = await app.inject({ method: 'GET', url: '/api/posts/missing/platform-previews' });
assert.equal(anonymous.statusCode, 401);
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];
const request = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });

async function createPost(title) {
  const response = await request('POST', '/api/posts', { projectId, title, body: `${title} base text`, scheduleMode: 'MANUAL' });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

function addImage(postId, name, width, height, order) {
  const mediaId = id('med');
  db.prepare(`INSERT INTO media
    (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(mediaId, postId, name, `${postId}/${name}`, 'image/jpeg', 1024, width, height,
      String(order + 1).repeat(64).slice(0, 64), nowIso(), order);
  return mediaId;
}

const carouselPost = await createPost('Carousel preview');
const first = addImage(carouselPost.id, 'first.jpg', 1200, 900, 0);
const second = addImage(carouselPost.id, 'second.jpg', 1200, 900, 1);
rich.setContentCompositionVersioned(carouselPost.id, carouselPost.content_version, 'FEED', 'CAROUSEL', [
  { mediaId: second, role: 'carousel_item' },
  { mediaId: first, role: 'carousel_item' }
]);
const carouselResponse = await request('GET', `/api/posts/${carouselPost.id}/platform-previews`);
assert.equal(carouselResponse.statusCode, 200, carouselResponse.body);
const carouselPreviews = carouselResponse.json().previews;
const telegram = carouselPreviews.find((item) => item.platform === 'telegram');
assert.ok(telegram);
assert.equal(telegram.publicationKind, 'FEED');
assert.equal(telegram.contentFormat, 'CAROUSEL');
assert.equal(telegram.captionPlacement, 'below');
assert.deepEqual(telegram.media.filter((item) => item.role !== 'poster').map((item) => item.id), [second, first]);
assert.equal(telegram.mediaCount, 2);
assert.equal(telegram.issues.length, 0);

const storyPost = await createPost('Story preview');
const storyImage = addImage(storyPost.id, 'story.jpg', 1000, 1200, 0);
const composition = rich.setContentCompositionVersioned(storyPost.id, storyPost.content_version, 'FEED', 'IMAGE', [
  { mediaId: storyImage, role: 'primary' }
]);
const instagramTarget = db.prepare(`SELECT pt.id FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
  WHERE pt.post_id=? AND a.platform='instagram'`).get(storyPost.id);
assert.ok(instagramTarget?.id);
delivery.saveTargetRendition(instagramTarget.id, {
  textPlain: 'Instagram resolved caption', publicationKind: 'STORY', contentFormat: 'IMAGE'
}, composition.contentVersion);
const storyResponse = await request('GET', `/api/posts/${storyPost.id}/platform-previews`);
assert.equal(storyResponse.statusCode, 200, storyResponse.body);
const instagram = storyResponse.json().previews.find((item) => item.platform === 'instagram');
assert.equal(instagram.text, 'Instagram resolved caption');
assert.equal(instagram.publicationKind, 'STORY');
assert.equal(instagram.contentFormat, 'IMAGE');
assert.equal(instagram.verticalSafeZone, true);
assert.ok(instagram.issues.some((issue) => issue.code === 'UNSUPPORTED_COMPOSITION' && issue.severity === 'error'));
assert.ok(instagram.issues.some((issue) => issue.code === 'VERTICAL_SAFE_ZONE_ASPECT' && issue.severity === 'warning'));

const source = await fs.readFile(new URL('../public/platform-previews-v3.js', import.meta.url), 'utf8');
for (const marker of ['platform-preview-grid', 'safe-top', 'captionPlacement', '.open-post', 'pixel-perfect']) {
  assert.ok(source.includes(marker), `frontend preview marker missing: ${marker}`);
}
const index = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
assert.ok(index.includes('/platform-previews-v3.css'));
assert.ok(index.includes('/platform-previews-v3.js'));

await app.close();
console.log('CX3-006 platform previews v2: PASS');
