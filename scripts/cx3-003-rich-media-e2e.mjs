import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-003-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cx3-003-ci-password';
process.env.APP_MASTER_KEY = 'cx3-003-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const rich = await import('../dist/rich-media.js');
const { snapshotContentRevision } = await import('../dist/content-versioning.js');

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
function addMedia(postId, name, mimeType, width, height, order) {
  const mediaId = id('med');
  db.prepare(`INSERT INTO media
    (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mediaId, postId, name, `${postId}/${name}`, mimeType, 100, width, height,
      String(order + 1).repeat(64).slice(0, 64), nowIso(), order);
  return mediaId;
}

const shortPost = createPost('Vertical short');
const videoId = addMedia(shortPost, 'clip.mp4', 'video/mp4', 1080, 1920, 0);
const posterId = addMedia(shortPost, 'poster.jpg', 'image/jpeg', 1080, 1920, 1);
let videoEdit = rich.setVideoMetadataVersioned(videoId, 1, {
  durationMs: 12345,
  fps: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mp4',
  posterAssetId: posterId
});
assert.equal(videoEdit.contentVersion, 2);
const composition = rich.setContentCompositionVersioned(shortPost, 2, 'SHORT', 'VERTICAL_VIDEO', [
  { mediaId: videoId, role: 'video' },
  { mediaId: posterId, role: 'poster' }
]);
assert.equal(composition.contentVersion, 3);
assert.deepEqual(composition.items.map((item) => item.role), ['video', 'poster']);
const videoRow = db.prepare(`SELECT duration_ms,fps,video_codec,audio_codec,container,poster_asset_id FROM media WHERE id=?`).get(videoId);
assert.deepEqual(videoRow, {
  duration_ms: 12345, fps: 30, video_codec: 'h264', audio_codec: 'aac', container: 'mp4', poster_asset_id: posterId
});
const shortRevision = snapshotContentRevision(shortPost, 3, 'cx3-003-short');
const shortRelation = JSON.parse(db.prepare('SELECT content_media_json FROM content_revisions WHERE id=?').get(shortRevision.id).content_media_json);
assert.deepEqual(shortRelation.map(({ mediaId, role }) => ({ mediaId, role })), [
  { mediaId: videoId, role: 'video' },
  { mediaId: posterId, role: 'poster' }
]);
const shortMediaSnapshot = JSON.parse(shortRevision.media_json).find((item) => item.id === videoId);
assert.equal(shortMediaSnapshot.duration_ms, 12345);
assert.equal(shortMediaSnapshot.poster_asset_id, posterId);

const storyPost = createPost('Story sequence');
const storyA = addMedia(storyPost, 'story-a.jpg', 'image/jpeg', 1080, 1920, 0);
const storyB = addMedia(storyPost, 'story-b.jpg', 'image/jpeg', 1080, 1920, 1);
const storyV2 = rich.setContentCompositionVersioned(storyPost, 1, 'STORY', 'STORY_SEQUENCE', [
  { mediaId: storyA, role: 'story_item', previewDurationMs: 5000 },
  { mediaId: storyB, role: 'story_item', previewDurationMs: 7000 }
]);
assert.equal(storyV2.contentVersion, 2);
const storyRevisionV2 = snapshotContentRevision(storyPost, 2, 'cx3-003-story-v2');
const snapshotV2 = JSON.parse(db.prepare('SELECT content_media_json FROM content_revisions WHERE id=?').get(storyRevisionV2.id).content_media_json);
assert.deepEqual(snapshotV2.map(({ mediaId, sortOrder, role, previewDurationMs }) => ({ mediaId, sortOrder, role, previewDurationMs })), [
  { mediaId: storyA, sortOrder: 0, role: 'story_item', previewDurationMs: 5000 },
  { mediaId: storyB, sortOrder: 1, role: 'story_item', previewDurationMs: 7000 }
]);
const storyV3 = rich.setContentCompositionVersioned(storyPost, 2, 'STORY', 'STORY_SEQUENCE', [
  { mediaId: storyB, role: 'story_item', previewDurationMs: 6000 },
  { mediaId: storyA, role: 'story_item', previewDurationMs: 8000 }
]);
assert.equal(storyV3.contentVersion, 3);
const storyRevisionV3 = snapshotContentRevision(storyPost, 3, 'cx3-003-story-v3');
const snapshotV3 = JSON.parse(db.prepare('SELECT content_media_json FROM content_revisions WHERE id=?').get(storyRevisionV3.id).content_media_json);
assert.deepEqual(snapshotV3.map(({ mediaId, sortOrder }) => ({ mediaId, sortOrder })), [
  { mediaId: storyB, sortOrder: 0 }, { mediaId: storyA, sortOrder: 1 }
]);
assert.deepEqual(JSON.parse(db.prepare('SELECT content_media_json FROM content_revisions WHERE id=?').get(storyRevisionV2.id).content_media_json), snapshotV2);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM publication_units').get().n, 0, 'authoring sequence must not create delivery units');

assert.throws(() => rich.setContentCompositionVersioned(storyPost, 3, 'FEED', 'STORY_SEQUENCE', [
  { mediaId: storyB, role: 'story_item' }, { mediaId: storyA, role: 'story_item' }
]), /Unsupported canonical composition/);
assert.throws(() => rich.setVideoMetadataVersioned(storyA, 3, { durationMs: 1000 }), /video asset/);

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-003',
  schemaVersion: Number(db.pragma('user_version', { simple: true })),
  videoMetadata: true,
  posterReference: true,
  contentMediaRoles: true,
  storySequenceOrder: true,
  previewDuration: true,
  immutableRelationSnapshot: true,
  authoringSeparatedFromPublicationUnits: true
}, null, 2));

db.close();
await fs.rm(dataDir, { recursive: true, force: true });
