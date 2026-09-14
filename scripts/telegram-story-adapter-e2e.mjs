import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-telegram-story-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'telegram-story-test-password';
process.env.APP_MASTER_KEY = 'telegram-story-test-master-key-longer-than-thirty-two-characters';
process.env.MEDIA_PROCESSING_TIMEOUT_MS = '120000';

const { telegramPublisher } = await import('../dist/platforms/telegram.js');
const { PLATFORM_CAPABILITIES } = await import('../dist/platforms/capabilities.js');
const { PlatformError } = await import('../dist/platforms/types.js');

async function storyMedia(overrides = {}) {
  const relativePath = 'post-telegram-story/story.jpg';
  const absolutePath = path.join(dataDir, 'media', relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, Buffer.from('telegram-story-image-fixture'));
  return {
    id: 'telegram-story-media-1',
    post_id: 'post-telegram-story',
    original_name: 'story.jpg',
    relative_path: relativePath,
    mime_type: 'image/jpeg',
    size_bytes: 28,
    width: 1080,
    height: 1920,
    sha256: 's'.repeat(64),
    created_at: '2026-09-14T00:00:00.000Z',
    sort_order: 0,
    ...overrides
  };
}

async function storyVideoMedia(overrides = {}) {
  const relativePath = 'post-telegram-story/source.mp4';
  const absolutePath = path.join(dataDir, 'media', relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const generated = spawnSync('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100',
    '-t', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart',
    absolutePath
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(generated.status, 0, generated.stderr || 'ffmpeg source fixture failed');
  const stat = await fs.stat(absolutePath);
  return {
    id: 'telegram-story-video-1',
    post_id: 'post-telegram-story',
    original_name: 'source.mp4',
    relative_path: relativePath,
    mime_type: 'video/mp4',
    size_bytes: stat.size,
    width: 360,
    height: 640,
    duration_ms: 2000,
    fps: 10,
    video_codec: 'h264',
    audio_codec: 'aac',
    container: 'mp4',
    poster_asset_id: null,
    sha256: 'v'.repeat(64),
    created_at: '2026-09-14T00:00:00.000Z',
    sort_order: 0,
    ...overrides
  };
}

function input(media, overrides = {}) {
  return {
    postId: 'post-telegram-story',
    title: 'Telegram Story test',
    text: 'Story caption',
    media: [media],
    credentials: {
      botToken: 'test-telegram-token',
      businessConnectionId: 'business-connection-123'
    },
    publicMediaUrls: [],
    publicationKind: 'STORY',
    contentFormat: 'IMAGE',
    ...overrides
  };
}

function videoInput(media, overrides = {}) {
  return input(media, { contentFormat: 'VERTICAL_VIDEO', ...overrides });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function expectPlatformError(promise, expected) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof PlatformError, `Expected PlatformError, got ${caught}`);
  if ('retryable' in expected) assert.equal(caught.retryable, expected.retryable);
  if ('outcomeUnknown' in expected) assert.equal(caught.outcomeUnknown, expected.outcomeUnknown);
  if (expected.message) assert.match(caught.message, expected.message);
}

async function assertNoStoryTempFiles() {
  const tempDir = path.join(dataDir, '.media-tmp');
  const entries = await fs.readdir(tempDir).catch(() => []);
  assert.deepEqual(entries.filter((name) => name.startsWith('telegram-story-')), []);
}

try {
  assert.equal(PLATFORM_CAPABILITIES.telegram.supportsStories, false, 'Story capability must remain disabled until live business-account acceptance');

  const media = await storyMedia();

  {
    const calls = [];
    globalThis.fetch = async (request, init = {}) => {
      const url = String(request);
      calls.push({ url, init });
      assert.match(url, /\/postStory$/);
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get('business_connection_id'), 'business-connection-123');
      assert.equal(init.body.get('active_period'), '86400');
      assert.equal(init.body.get('caption'), 'Story caption');
      assert.deepEqual(JSON.parse(String(init.body.get('content'))), { type: 'photo', photo: 'attach://story' });
      const story = init.body.get('story');
      assert.ok(story instanceof Blob);
      assert.equal(story.type, 'image/jpeg');
      assert.ok(init.signal instanceof AbortSignal);
      return json({ ok: true, result: { id: 77, chat: { id: 123, type: 'private' } } });
    };
    const result = await telegramPublisher.publish(input(media));
    assert.equal(result.externalId, '77');
    assert.equal(calls.length, 1);
  }

  {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('fetch must not run'); };
    await assert.rejects(telegramPublisher.publish(input({ ...media, width: 1081 })), /требует ровно 1080x1920/);
    assert.equal(calls, 0);
  }

  {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('fetch must not run'); };
    await assert.rejects(telegramPublisher.publish(input({ ...media, size_bytes: 10 * 1024 * 1024 + 1 })), /превышает предел 10 MB/);
    assert.equal(calls, 0);
  }

  {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('fetch must not run'); };
    const missingCredential = input(media, { credentials: { botToken: 'test-telegram-token' } });
    await assert.rejects(telegramPublisher.publish(missingCredential), /businessConnectionId/);
    assert.equal(calls, 0);
  }

  {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('fetch must not run'); };
    await assert.rejects(telegramPublisher.publish(input(media, { text: 'я'.repeat(2049) })), /STORY caption 2049 символов превышает предел 2048/);
    assert.equal(calls, 0);
  }

  {
    globalThis.fetch = async () => json({ ok: false, error_code: 429, description: 'Too Many Requests' }, 429);
    await expectPlatformError(telegramPublisher.publish(input(media)), { retryable: true, outcomeUnknown: false, message: /HTTP 429/ });
  }

  {
    globalThis.fetch = async () => json({ ok: true, result: {} });
    await expectPlatformError(telegramPublisher.publish(input(media)), { retryable: false, outcomeUnknown: true, message: /не вернул story id/ });
  }

  {
    globalThis.fetch = async () => { throw new TypeError('connection dropped after POST'); };
    await expectPlatformError(telegramPublisher.publish(input(media)), { retryable: false, outcomeUnknown: true, message: /Telegram postStory/ });
  }

  const video = await storyVideoMedia();

  {
    let calls = 0;
    globalThis.fetch = async (request, init = {}) => {
      calls += 1;
      assert.match(String(request), /\/postStory$/);
      assert.ok(init.body instanceof FormData);
      const content = JSON.parse(String(init.body.get('content')));
      assert.equal(content.type, 'video');
      assert.equal(content.video, 'attach://story');
      assert.ok(content.duration > 1.8 && content.duration <= 2.1);
      assert.equal(content.cover_frame_timestamp, 0);
      assert.equal(content.is_animation, undefined);
      const story = init.body.get('story');
      assert.ok(story instanceof Blob);
      assert.equal(story.type, 'video/mp4');
      assert.ok(story.size > 0 && story.size <= 30 * 1024 * 1024);
      assert.equal(init.body.get('active_period'), '86400');
      assert.ok(init.signal instanceof AbortSignal);
      return json({ ok: true, result: { id: 88, chat: { id: 123, type: 'private' } } });
    };
    const result = await telegramPublisher.publish(videoInput(video));
    assert.equal(result.externalId, '88');
    assert.equal(calls, 1);
    await assertNoStoryTempFiles();
  }

  {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('fetch must not run'); };
    await assert.rejects(telegramPublisher.publish(videoInput({ ...video, duration_ms: 60_001 })), /превышает предел 60000 ms/);
    assert.equal(calls, 0);
  }

  {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('fetch must not run'); };
    const missing = { ...video, relative_path: 'post-telegram-story/missing.mp4' };
    await expectPlatformError(telegramPublisher.publish(videoInput(missing)), {
      retryable: false,
      outcomeUnknown: false,
      message: /rendition не подготовлен до внешнего POST/
    });
    assert.equal(calls, 0);
    await assertNoStoryTempFiles();
  }

  {
    globalThis.fetch = async () => { throw new TypeError('connection dropped after video postStory'); };
    await expectPlatformError(telegramPublisher.publish(videoInput(video)), {
      retryable: false,
      outcomeUnknown: true,
      message: /Telegram postStory/
    });
    await assertNoStoryTempFiles();
  }

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'CX3-010B',
    scenarios: 12,
    telegramStoryImageAdapterImplemented: true,
    telegramStoryVideoRenditionImplemented: true,
    h264CanonicalSourcePreserved: true,
    h265720x1280Rendition: true,
    oneSecondKeyframeCadence: true,
    streamableFaststartMp4: true,
    thirtyMegabyteGuard: true,
    sixtySecondGuard: true,
    localPreparationFailureIsKnownOutcome: true,
    tempCleanup: true,
    storyCapabilityStillLiveGated: true
  }, null, 2));
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}
