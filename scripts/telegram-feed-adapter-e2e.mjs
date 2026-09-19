import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-telegram-adapter-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'telegram-adapter-test-password';
process.env.APP_MASTER_KEY = 'telegram-adapter-test-master-key-longer-than-thirty-two-characters';

const { telegramPublisher } = await import('../dist/platforms/telegram.js');
const { PLATFORM_CAPABILITIES } = await import('../dist/platforms/capabilities.js');
const { PlatformError } = await import('../dist/platforms/types.js');
const { compilePlatformText } = await import('../dist/platform-text.js');
const { db } = await import('../dist/db.js');

async function makeMedia(index) {
  const relativePath = `post-telegram-test/${index}.jpg`;
  const absolutePath = path.join(dataDir, 'media', relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, Buffer.from(`telegram-image-${index}`));
  return {
    id: `telegram-media-${index}`,
    post_id: 'post-telegram-test',
    original_name: `${index}.jpg`,
    relative_path: relativePath,
    mime_type: 'image/jpeg',
    size_bytes: 18,
    width: 100,
    height: 100,
    sha256: String(index).padEnd(64, '0').slice(0, 64),
    created_at: '2026-09-10T00:00:00.000Z',
    sort_order: index
  };
}

async function makeVideo({ sizeBytes = 4096, videoCodec = 'h264', audioCodec = 'aac', container = 'mp4' } = {}) {
  const relativePath = 'post-telegram-test/clip.mp4';
  const absolutePath = path.join(dataDir, 'media', relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, Buffer.from('telegram-video-fixture'));
  return {
    id: 'telegram-video-1',
    post_id: 'post-telegram-test',
    original_name: 'clip.mp4',
    relative_path: relativePath,
    mime_type: 'video/mp4',
    size_bytes: sizeBytes,
    width: 1080,
    height: 1920,
    duration_ms: 12_500,
    fps: 30,
    video_codec: videoCodec,
    audio_codec: audioCodec,
    container,
    poster_asset_id: 'telegram-poster-1',
    sha256: 'v'.repeat(64),
    created_at: '2026-09-10T00:00:00.000Z',
    sort_order: 0
  };
}

const media1 = await makeMedia(1);
const media2 = await makeMedia(2);
const video1 = await makeVideo();

function input({
  text = 'Короткий Telegram текст',
  media = [media1],
  publicationKind,
  contentFormat
} = {}) {
  return {
    postId: 'post-telegram-test',
    title: 'Telegram adapter test',
    text,
    media,
    credentials: { botToken: 'test-telegram-token', chatId: '@test-channel' },
    publicMediaUrls: [],
    ...(publicationKind ? { publicationKind } : {}),
    ...(contentFormat ? { contentFormat } : {})
  };
}

function videoInput(options = {}) {
  return input({ publicationKind: 'FEED', contentFormat: 'VIDEO', media: [video1], ...options });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function telegramMethod(url) {
  const match = /\/bot[^/]+\/(sendPhoto|sendMediaGroup|sendVideo|sendMessage)$/.exec(url);
  return match?.[1] || null;
}

function mockFetch(steps) {
  const calls = [];
  globalThis.fetch = async (request, init = {}) => {
    const url = String(request);
    const call = { url, method: String(init.method || 'GET').toUpperCase(), telegramMethod: telegramMethod(url), init };
    calls.push(call);
    const step = steps.shift();
    assert.ok(step, `Unexpected fetch ${call.method} ${url}`);
    if (step.telegramMethod) assert.equal(call.telegramMethod, step.telegramMethod);
    if (step.check) step.check(call);
    if (step.error) throw step.error;
    return json(step.response ?? {}, step.status ?? 200);
  };
  return calls;
}

async function expectPlatformError(promise, expected) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PlatformError, `Expected PlatformError, got ${caught}`);
  if ('retryable' in expected) assert.equal(caught.retryable, expected.retryable);
  if ('outcomeUnknown' in expected) assert.equal(caught.outcomeUnknown, expected.outcomeUnknown);
  if (expected.message) assert.match(caught.message, expected.message);
}

try {
  assert.equal(PLATFORM_CAPABILITIES.telegram.supportsVideo, false, 'Telegram video capability must remain gated until live acceptance');
  assert.equal(PLATFORM_CAPABILITIES.telegram.supportsStories, false);
  assert.equal(PLATFORM_CAPABILITIES.telegram.supportsShortVideo, false);
  assert.equal(PLATFORM_CAPABILITIES.telegram.verification.richMediaPendingLiveAcceptance, true);

  {
    const steps = [{
      telegramMethod: 'sendPhoto',
      check: (call) => {
        assert.ok(call.init.body instanceof FormData);
        assert.equal(call.init.body.get('chat_id'), '@test-channel');
        assert.equal(call.init.body.get('caption'), 'Короткий Telegram текст');
        assert.ok(call.init.signal instanceof AbortSignal);
      },
      response: { ok: true, result: { message_id: 101 } }
    }];
    const calls = mockFetch(steps);
    const result = await telegramPublisher.publish(input());
    assert.equal(result.externalId, '101');
    assert.equal(calls.length, 1);
    assert.equal(steps.length, 0);
  }

  {
    const richDoc={type:'doc',content:[{type:'paragraph',content:[
      {type:'text',text:'Telegram ',marks:[]},
      {type:'text',text:'bold🙂',marks:[{type:'bold'}]},
      {type:'text',text:' ',marks:[]},
      {type:'link',attrs:{href:'https://example.test/tg'},content:[{type:'text',text:'link',marks:[{type:'underline'}]}]}
    ]}]};
    const compiled=compilePlatformText('telegram',richDoc,'media_caption');
    assert.equal(compiled.transport.kind,'telegram_entities');
    const steps=[{
      telegramMethod:'sendPhoto',
      check:(call)=>{
        assert.ok(call.init.body instanceof FormData);
        assert.equal(call.init.body.get('caption'),compiled.transport.text);
        assert.deepEqual(JSON.parse(String(call.init.body.get('caption_entities'))),compiled.transport.entities);
        assert.equal(call.init.body.get('parse_mode'),null);
      },
      response:{ok:true,result:{message_id:151}}
    }];
    mockFetch(steps);
    const result=await telegramPublisher.publish({
      ...input({text:compiled.plainText}),
      textCompilation:compiled
    });
    assert.equal(result.externalId,'151');
    assert.equal(steps.length,0);
  }

  {
    const steps = [{
      telegramMethod: 'sendMediaGroup',
      check: (call) => {
        assert.ok(call.init.body instanceof FormData);
        const descriptors = JSON.parse(String(call.init.body.get('media')));
        assert.equal(descriptors.length, 2);
        assert.equal(descriptors[0].caption, 'Короткий Telegram текст');
        assert.equal(descriptors[1].caption, undefined);
      },
      response: { ok: true, result: [{ message_id: 201 }, { message_id: 202 }] }
    }];
    mockFetch(steps);
    const result = await telegramPublisher.publish(input({ media: [media1, media2] }));
    assert.equal(result.externalId, '201');
    assert.equal(steps.length, 0);
  }

  {
    const steps = [{
      telegramMethod: 'sendVideo',
      check: (call) => {
        assert.ok(call.init.body instanceof FormData);
        assert.equal(call.init.body.get('chat_id'), '@test-channel');
        assert.equal(call.init.body.get('caption'), 'Короткий Telegram текст');
        assert.equal(call.init.body.get('supports_streaming'), 'true');
        assert.equal(call.init.body.get('width'), '1080');
        assert.equal(call.init.body.get('height'), '1920');
        assert.equal(call.init.body.get('duration'), '13');
        const video = call.init.body.get('video');
        assert.ok(video instanceof Blob);
        assert.equal(video.type, 'video/mp4');
        assert.ok(call.init.signal instanceof AbortSignal);
      },
      response: { ok: true, result: { message_id: 251, video: { file_id: 'video-file-id' } } }
    }];
    const calls = mockFetch(steps);
    const result = await telegramPublisher.publish(videoInput());
    assert.equal(result.externalId, '251');
    assert.equal(calls.length, 1);
    assert.equal(steps.length, 0);
  }

  {
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error('fetch must not run'); };
    const oversized = await makeVideo({ sizeBytes: 50 * 1024 * 1024 + 1 });
    await assert.rejects(telegramPublisher.publish(videoInput({ media: [oversized] })), /превышает предел 50 MB/);
    assert.equal(fetchCalls, 0);
  }

  {
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error('fetch must not run'); };
    const hevc = await makeVideo({ videoCodec: 'hevc' });
    await assert.rejects(telegramPublisher.publish(videoInput({ media: [hevc] })), /canonical video должен быть H\.264/);
    assert.equal(fetchCalls, 0);
  }

  {
    const missing = { ...media1, relative_path: 'post-telegram-test/missing.jpg' };
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error('fetch must not run'); };
    await expectPlatformError(telegramPublisher.publish(input({ media: [missing] })), {
      retryable: false, outcomeUnknown: false, message: /локальный media недоступен/
    });
    assert.equal(fetchCalls, 0);
  }

  {
    const steps = [{ telegramMethod: 'sendPhoto', status: 429, response: { ok: false, error_code: 429, description: 'Too Many Requests' } }];
    mockFetch(steps);
    await expectPlatformError(telegramPublisher.publish(input()), { retryable: true, outcomeUnknown: false, message: /HTTP 429/ });
  }

  {
    const steps = [{ telegramMethod: 'sendPhoto', status: 503, response: { ok: false, description: 'Unavailable' } }];
    mockFetch(steps);
    await expectPlatformError(telegramPublisher.publish(input()), { retryable: false, outcomeUnknown: true, message: /HTTP 503/ });
  }

  {
    const steps = [{ telegramMethod: 'sendPhoto', error: new TypeError('connection dropped') }];
    mockFetch(steps);
    await expectPlatformError(telegramPublisher.publish(input()), { retryable: false, outcomeUnknown: true, message: /Telegram sendPhoto/ });
  }

  {
    const richLong={type:'doc',content:[{type:'paragraph',content:[
      {type:'text',text:'я'.repeat(1021),marks:[]},
      {type:'text',text:'Ж🙂Ж',marks:[{type:'bold'}]}
    ]}]};
    const compiled=compilePlatformText('telegram',richLong,'media_caption');
    assert.equal(compiled.transport.kind,'telegram_entities');
    assert.ok(compiled.transport.text.length>1024);
    const steps = [
      { telegramMethod: 'sendPhoto', check: (call) => { assert.equal(call.init.body.get('caption'), ''); assert.equal(call.init.body.get('caption_entities'), null); }, response: { ok: true, result: { message_id: 301 } } },
      { telegramMethod: 'sendMessage', check: (call) => {
        const body = JSON.parse(String(call.init.body));
        assert.equal(body.text, compiled.transport.text);
        assert.deepEqual(body.entities, compiled.transport.entities);
        assert.equal(body.parse_mode, undefined);
        assert.ok(call.init.signal instanceof AbortSignal);
      }, status: 400, response: { ok: false, error_code: 400, description: 'Bad Request' } }
    ];
    mockFetch(steps);
    await expectPlatformError(telegramPublisher.publish({ ...input({ text: compiled.plainText }), textCompilation: compiled }), {
      retryable: false, outcomeUnknown: true, message: /media уже опубликовано \(message_id=301\).*повтор всего target заблокирован/
    });
  }

  {
    const longText = 'в'.repeat(1025);
    const steps = [
      { telegramMethod: 'sendVideo', check: (call) => assert.equal(call.init.body.get('caption'), ''), response: { ok: true, result: { message_id: 351 } } },
      { telegramMethod: 'sendMessage', status: 503, response: { ok: false, description: 'Unavailable' } }
    ];
    mockFetch(steps);
    await expectPlatformError(telegramPublisher.publish(videoInput({ text: longText })), {
      retryable: false, outcomeUnknown: true, message: /media уже опубликовано \(message_id=351\).*повтор всего target заблокирован/
    });
  }

  {
    const steps = [{ telegramMethod: 'sendVideo', response: { ok: true, result: {} } }];
    mockFetch(steps);
    await expectPlatformError(telegramPublisher.publish(videoInput()), {
      retryable: false, outcomeUnknown: true, message: /не вернул message_id/
    });
  }

  console.log(JSON.stringify({ ok: true, scenarios: 13, feedVideoAdapterImplemented: true, videoCapabilityStillLiveGated: true }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
