import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const phase = process.argv[2] || 'full';
if (!['upload', 'rejection', 'full'].includes(phase)) throw new Error(`Unknown CX3-008A phase: ${phase}`);

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-008a-'));
const toolDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-008a-tools-'));
const ffprobePath = path.join(toolDir, 'ffprobe-test');
const ffmpegPath = path.join(toolDir, 'ffmpeg-test');
const posterFixture = path.join(toolDir, 'poster.jpg');

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cx3-008a-ci-password';
process.env.APP_MASTER_KEY = 'cx3-008a-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';
process.env.MAX_IMAGE_BYTES = String(1024 * 1024);
process.env.MAX_VIDEO_BYTES = String(1024 * 1024);
process.env.MEDIA_TEMP_BUDGET_BYTES = String(3 * 1024 * 1024);
process.env.MEDIA_PROCESSING_TIMEOUT_MS = '5000';
process.env.FFPROBE_PATH = ffprobePath;
process.env.FFMPEG_PATH = ffmpegPath;
process.env.FAKE_VIDEO_CODEC = 'h264';
process.env.FAKE_AUDIO_CODEC = 'aac';
process.env.FAKE_POSTER_FIXTURE = posterFixture;

const sharp = (await import('sharp')).default;
await sharp({ create: { width: 180, height: 320, channels: 3, background: { r: 30, g: 60, b: 90 } } })
  .jpeg({ quality: 85 })
  .toFile(posterFixture);

await fs.writeFile(ffprobePath, `#!/usr/bin/env node
const videoCodec = process.env.FAKE_VIDEO_CODEC || 'h264';
const audioCodec = process.env.FAKE_AUDIO_CODEC || 'aac';
const streams = [{ codec_type: 'video', codec_name: videoCodec, width: 1080, height: 1920, avg_frame_rate: '30000/1001', duration: '12.500' }];
if (audioCodec !== 'none') streams.push({ codec_type: 'audio', codec_name: audioCodec });
process.stdout.write(JSON.stringify({ streams, format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.500' } }));
`);
await fs.writeFile(ffmpegPath, `#!/usr/bin/env node
const fs = require('node:fs');
const output = process.argv[process.argv.length - 1];
fs.copyFileSync(process.env.FAKE_POSTER_FIXTURE, output);
`);
await fs.chmod(ffprobePath, 0o755);
await fs.chmod(ffmpegPath, 0o755);

const { db, migrate } = await import('../dist/db.js');
const { snapshotContentRevision, revisionContentMedia, revisionMedia } = await import('../dist/content-versioning.js');
const { cleanupVideoTemp } = await import('../dist/video-media.js');
const { buildApp } = await import('../dist/app.js');

migrate();
await cleanupVideoTemp();
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

async function createPost(projectId, title) {
  return json('/api/posts', {
    method: 'POST',
    body: JSON.stringify({ projectId, title, body: `${title} body`, scheduleMode: 'MANUAL' })
  }, 201);
}

async function uploadVideo(postId, contentVersion, bytes, expectedStatus = 201, name = 'clip.mp4') {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'video/mp4' }), name);
  return json(`/api/posts/${postId}/video`, {
    method: 'POST',
    body: form,
    headers: { 'x-content-version': String(contentVersion) }
  }, expectedStatus);
}

try {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'cx3-008a-ci-password' })
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];

  const project = await json('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'CX3-008A', slug: 'cx3-008a' })
  }, 201);

  const post = await createPost(project.id, 'Canonical video');
  const originalBytes = Buffer.from('fake-mp4-payload-for-bounded-streaming-test');
  const uploaded = await uploadVideo(post.id, post.content_version, originalBytes);
  assert.equal(uploaded.mime_type, 'video/mp4');
  assert.equal(uploaded.video_codec, 'h264');
  assert.equal(uploaded.audio_codec, 'aac');
  assert.equal(uploaded.container, 'mp4');
  assert.equal(uploaded.duration_ms, 12500);
  assert.ok(Math.abs(uploaded.fps - (30000 / 1001)) < 0.001);
  assert.equal(uploaded.width, 1080);
  assert.equal(uploaded.height, 1920);
  assert.equal(uploaded.poster.mime_type, 'image/jpeg');
  assert.equal(uploaded.poster_asset_id, uploaded.poster.id);
  assert.equal(uploaded.contentVersion, post.content_version + 1);

  const stored = await json(`/api/posts/${post.id}`);
  assert.equal(stored.publication_kind, 'FEED');
  assert.equal(stored.content_format, 'VIDEO');
  assert.equal(stored.media.length, 2);
  const storedVideo = stored.media.find((item) => item.mime_type === 'video/mp4');
  assert.ok(storedVideo);
  const storedPoster = stored.media.find((item) => item.id === storedVideo.poster_asset_id);
  assert.ok(storedPoster);
  assert.equal(storedPoster.mime_type, 'image/jpeg');

  const relation = db.prepare('SELECT media_id,sort_order,role FROM content_media WHERE post_id=? ORDER BY sort_order').all(post.id);
  assert.deepEqual(relation, [
    { media_id: storedVideo.id, sort_order: 0, role: 'video' },
    { media_id: storedPoster.id, sort_order: 1, role: 'poster' }
  ]);

  const revision = snapshotContentRevision(post.id, stored.content_version, 'cx3-008a-test');
  const revisionRelation = revisionContentMedia(revision);
  assert.deepEqual(revisionRelation.map(({ mediaId, role }) => ({ mediaId, role })), [
    { mediaId: storedVideo.id, role: 'video' },
    { mediaId: storedPoster.id, role: 'poster' }
  ]);
  const publicationMedia = revisionMedia(revision);
  assert.equal(publicationMedia.length, 1, 'poster must not be sent as publication media');
  assert.equal(publicationMedia[0].id, storedVideo.id);

  const videoBytesOnDisk = await fs.readFile(path.join(dataDir, 'media', storedVideo.relative_path));
  assert.deepEqual(videoBytesOnDisk, originalBytes);
  const posterBytesOnDisk = await fs.readFile(path.join(dataDir, 'media', storedPoster.relative_path));
  const posterMeta = await sharp(posterBytesOnDisk).metadata();
  assert.equal(posterMeta.format, 'jpeg');

  if (phase !== 'upload') {
    const badCodecPost = await createPost(project.id, 'Bad codec');
    process.env.FAKE_VIDEO_CODEC = 'hevc';
    const badCodec = await uploadVideo(badCodecPost.id, badCodecPost.content_version, Buffer.from('not-h264'), 400);
    assert.match(badCodec.error, /H\.264/);
    const badCodecAfter = await json(`/api/posts/${badCodecPost.id}`);
    assert.equal(badCodecAfter.media.length, 0);
    assert.equal(badCodecAfter.content_version, badCodecPost.content_version);
    process.env.FAKE_VIDEO_CODEC = 'h264';

    const oversizePost = await createPost(project.id, 'Oversize');
    const oversize = await uploadVideo(oversizePost.id, oversizePost.content_version, Buffer.alloc(1024 * 1024 + 1), 413);
    assert.match(oversize.error, /лимит|превыш/i);
    const oversizeAfter = await json(`/api/posts/${oversizePost.id}`);
    assert.equal(oversizeAfter.media.length, 0);
    assert.equal(oversizeAfter.content_version, oversizePost.content_version);
  }

  if (phase === 'full') {
    const beforeDeleteVideoPath = path.join(dataDir, 'media', storedVideo.relative_path);
    const beforeDeletePosterPath = path.join(dataDir, 'media', storedPoster.relative_path);
    await json(`/api/media/${storedVideo.id}`, {
      method: 'DELETE',
      headers: { 'x-content-version': String(stored.content_version) }
    });
    const afterDelete = await json(`/api/posts/${post.id}`);
    assert.equal(afterDelete.media.length, 0);
    assert.equal(afterDelete.content_format, 'IMAGE');
    await assert.rejects(fs.access(beforeDeleteVideoPath));
    await assert.rejects(fs.access(beforeDeletePosterPath));

    const tempDir = path.join(dataDir, '.media-tmp');
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'stale.tmp'), 'stale');
    await cleanupVideoTemp();
    assert.deepEqual(await fs.readdir(tempDir), []);
  }

  console.log(JSON.stringify({ ok: true, checkpoint: 'CX3-008A', phase }, null, 2));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(toolDir, { recursive: true, force: true });
}
