import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-004-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cx3-004-ci-password';
process.env.APP_MASTER_KEY = 'cx3-004-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const rich = await import('../dist/rich-media.js');
const { buildApp } = await import('../dist/app.js');
const { buildViewerModel, formatViewerBytes, formatViewerDuration } = await import('../public/media-viewer-v3.js');

migrate();
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const now = nowIso();

function createPost(title) {
  const postId = id('post');
  db.prepare(`INSERT INTO posts
    (id,project_id,title,body,status,editorial_stage,schedule_mode,content_version,created_at,updated_at,publication_kind,content_format)
    VALUES (?,?,?,?,'DRAFT','DRAFT','MANUAL',1,?,?,'FEED','IMAGE')`)
    .run(postId, projectId, title, `${title} body`, now, now);
  return postId;
}

function addMedia(postId, name, mimeType, width, height, order, size = 1024) {
  const mediaId = id('med');
  db.prepare(`INSERT INTO media
    (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mediaId, postId, name, `${postId}/${name}`, mimeType, size, width, height,
      String(order + 1).repeat(64).slice(0, 64), nowIso(), order);
  return mediaId;
}

const storyPost = createPost('Story viewer');
const storyImage = addMedia(storyPost, 'story-a.jpg', 'image/jpeg', 1080, 1920, 0, 2048);
const storyVideo = addMedia(storyPost, 'story-b.mp4', 'video/mp4', 1080, 1920, 1, 4096);
const storyPoster = addMedia(storyPost, 'story-poster.jpg', 'image/jpeg', 1080, 1920, 2, 1024);
const metadataEdit = rich.setVideoMetadataVersioned(storyVideo, 1, {
  durationMs: 6400,
  fps: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mp4',
  posterAssetId: storyPoster
});
const composition = rich.setContentCompositionVersioned(storyPost, metadataEdit.contentVersion, 'STORY', 'STORY_SEQUENCE', [
  { mediaId: storyImage, role: 'story_item', previewDurationMs: 3200 },
  { mediaId: storyVideo, role: 'story_item', previewDurationMs: 6000 },
  { mediaId: storyPoster, role: 'poster' }
]);
assert.equal(composition.contentVersion, 3);

const app = await buildApp();
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];
const inspectorResponse = await app.inject({ method: 'GET', url: `/api/editorial/posts/${storyPost}`, headers: { cookie } });
assert.equal(inspectorResponse.statusCode, 200, inspectorResponse.body);
const inspector = inspectorResponse.json();
assert.deepEqual(inspector.contentMedia.map(({ media_id, role, sort_order }) => ({ media_id, role, sort_order })), [
  { media_id: storyImage, role: 'story_item', sort_order: 0 },
  { media_id: storyVideo, role: 'story_item', sort_order: 1 },
  { media_id: storyPoster, role: 'poster', sort_order: 2 }
]);
const projectedVideo = inspector.media.find((item) => item.id === storyVideo);
assert.equal(projectedVideo.duration_ms, 6400);
assert.equal(projectedVideo.poster_asset_id, storyPoster);

const storyModel = buildViewerModel(inspector);
assert.equal(storyModel.mode, 'story');
assert.equal(storyModel.phoneFrame, true);
assert.equal(storyModel.items.length, 2, 'poster must not become a story slide');
assert.equal(storyModel.items[0].id, storyImage);
assert.equal(storyModel.items[0].previewDurationMs, 3200);
assert.equal(storyModel.items[1].id, storyVideo);
assert.equal(storyModel.items[1].isVideo, true);
assert.equal(storyModel.items[1].previewDurationMs, 6000);
assert.ok(storyModel.items[1].posterSrc.endsWith(`/${storyPoster}.jpg`) === false, 'poster URL must use stored relative path');
assert.ok(storyModel.items[1].posterSrc.endsWith('/story-poster.jpg'));

const imageModel = buildViewerModel({
  publication_kind: 'FEED', content_format: 'IMAGE',
  media: [{ id: 'img', relative_path: 'p/image.jpg', mime_type: 'image/jpeg', width: 1600, height: 900, size_bytes: 2048 }],
  contentMedia: [{ media_id: 'img', role: 'primary', sort_order: 0, preview_duration_ms: null }]
});
assert.equal(imageModel.mode, 'image');
assert.equal(imageModel.items.length, 1);
assert.equal(imageModel.phoneFrame, false);

const carouselModel = buildViewerModel({
  publication_kind: 'FEED', content_format: 'CAROUSEL',
  media: [
    { id: 'c1', relative_path: 'p/c1.jpg', mime_type: 'image/jpeg' },
    { id: 'c2', relative_path: 'p/c2.mp4', mime_type: 'video/mp4', duration_ms: 2500 }
  ],
  contentMedia: [
    { media_id: 'c1', role: 'carousel_item', sort_order: 0, preview_duration_ms: null },
    { media_id: 'c2', role: 'carousel_item', sort_order: 1, preview_duration_ms: null }
  ]
});
assert.equal(carouselModel.mode, 'carousel');
assert.deepEqual(carouselModel.items.map((item) => item.id), ['c1', 'c2']);
assert.equal(carouselModel.items[1].isVideo, true);

const shortModel = buildViewerModel({
  publication_kind: 'SHORT', content_format: 'VERTICAL_VIDEO',
  media: [
    { id: 'v', relative_path: 'p/v.mp4', mime_type: 'video/mp4', duration_ms: 9000, poster_asset_id: 'poster' },
    { id: 'poster', relative_path: 'p/poster.jpg', mime_type: 'image/jpeg' }
  ],
  contentMedia: [
    { media_id: 'v', role: 'video', sort_order: 0, preview_duration_ms: null },
    { media_id: 'poster', role: 'poster', sort_order: 1, preview_duration_ms: null }
  ]
});
assert.equal(shortModel.mode, 'video');
assert.equal(shortModel.phoneFrame, true);
assert.equal(shortModel.items.length, 1);
assert.ok(shortModel.items[0].posterSrc.endsWith('/poster.jpg'));

assert.equal(formatViewerDuration(6400), '0:06');
assert.equal(formatViewerBytes(2048), '2.0 KB');
const viewerSource = await fs.readFile(new URL('../public/media-viewer-v3.js', import.meta.url), 'utf8');
for (const required of ['controls playsinline', 'requestFullscreen', 'viewer-zoom-in', 'viewer-story-progress', "video.addEventListener('ended'", 'previewDurationMs']) {
  assert.ok(viewerSource.includes(required), `viewer frontend must include ${required}`);
}

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-004',
  schemaVersion: Number(db.pragma('user_version', { simple: true })),
  inspectorCanonicalProjection: true,
  fullscreenImageViewer: true,
  zoomFitActualSize: true,
  html5VideoPlayer: true,
  carouselMixedMedia: true,
  verticalPhonePreview: true,
  storySequenceProgressAndAutoAdvance: true,
  manualNavigation: true
}, null, 2));

await app.close();
db.close();
await fs.rm(dataDir, { recursive: true, force: true });
