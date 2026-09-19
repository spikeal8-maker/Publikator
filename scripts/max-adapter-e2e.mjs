import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-max-adapter-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'max-adapter-test-password';
process.env.APP_MASTER_KEY = 'max-adapter-test-master-key-longer-than-thirty-two-characters';

const { maxPublisher } = await import('../dist/platforms/max.js');
const { PLATFORM_CAPABILITIES, platformRequiresPublicHttpsMedia } = await import('../dist/platforms/capabilities.js');
const { PlatformError } = await import('../dist/platforms/types.js');
const { compilePlatformText } = await import('../dist/platform-text.js');

function media(index) {
  return {
    id: `max-media-${index}`,
    post_id: 'max-post',
    original_name: `${index}.jpg`,
    relative_path: `max-post/${index}.jpg`,
    mime_type: 'image/jpeg',
    size_bytes: 128,
    width: 100,
    height: 100,
    sha256: String(index).padEnd(64, '0').slice(0, 64),
    created_at: '2026-09-10T00:00:00.000Z',
    sort_order: index
  };
}

const videoRelativePath = 'max-post/video.mp4';
const videoAbsolutePath = path.join(dataDir, 'media', videoRelativePath);
await fs.mkdir(path.dirname(videoAbsolutePath), { recursive: true });
await fs.writeFile(videoAbsolutePath, Buffer.from('max-video-test-fixture'));

const videoMedia = {
  id: 'max-video-1',
  post_id: 'max-post',
  original_name: 'video.mp4',
  relative_path: videoRelativePath,
  mime_type: 'video/mp4',
  size_bytes: 22,
  width: 1080,
  height: 1920,
  duration_ms: 12_500,
  fps: 30,
  video_codec: 'h264',
  audio_codec: 'aac',
  container: 'mp4',
  poster_asset_id: 'max-poster-1',
  sha256: 'v'.repeat(64),
  created_at: '2026-09-10T00:00:00.000Z',
  sort_order: 0
};

function input({ text = 'MAX test', count = 1, urls } = {}) {
  const mediaRows = Array.from({ length: count }, (_, index) => media(index));
  return {
    postId: 'max-post',
    title: 'MAX adapter test',
    text,
    media: mediaRows,
    credentials: { accessToken: 'max-test-token', chatId: '-100500' },
    publicMediaUrls: urls ?? mediaRows.map((_, index) => `https://publisher.example.test/public-media/${index}.jpg`)
  };
}

function videoInput(overrides = {}) {
  return {
    postId: 'max-post',
    title: 'MAX video adapter test',
    text: 'MAX video test',
    media: [videoMedia],
    credentials: { accessToken: 'max-test-token', chatId: '-100500' },
    publicMediaUrls: [],
    publicationKind: 'FEED',
    contentFormat: 'VIDEO',
    ...overrides
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function mockFetch(steps) {
  const calls = [];
  globalThis.fetch = async (request, init = {}) => {
    const url = String(request);
    const call = { url, init };
    calls.push(call);
    const step = steps.shift();
    assert.ok(step, `Unexpected fetch ${String(init.method || 'GET')} ${url}`);
    if (step.url) assert.equal(url, step.url);
    if (step.urlPattern) assert.match(url, step.urlPattern);
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
  if (expected.code !== undefined) assert.equal(caught.code, expected.code);
  if (expected.message) assert.match(caught.message, expected.message);
}

try {
  assert.equal(PLATFORM_CAPABILITIES.max.supportsVideo, false, 'MAX video capability must remain gated until live acceptance');
  assert.equal(PLATFORM_CAPABILITIES.max.supportsStories, false);
  assert.equal(PLATFORM_CAPABILITIES.max.supportsShortVideo, false);
  assert.equal(PLATFORM_CAPABILITIES.max.verification.richMediaPendingLiveAcceptance, true);
  assert.equal(platformRequiresPublicHttpsMedia('max', 'IMAGE'), true);
  assert.equal(platformRequiresPublicHttpsMedia('max', 'CAROUSEL'), true);
  assert.equal(platformRequiresPublicHttpsMedia('max', 'VIDEO'), false);
  assert.equal(platformRequiresPublicHttpsMedia('instagram', 'VIDEO'), true);

  // 1. Unicode characters, not UTF-16 code units, define the 4000-char boundary.
  assert.doesNotThrow(() => maxPublisher.validate(input({ text: '🙂'.repeat(4000) })));
  assert.throws(() => maxPublisher.validate(input({ text: '🙂'.repeat(4001) })), /превышает предел 4000/);

  // 2-5. Existing image/public URL validation remains strict.
  assert.throws(() => maxPublisher.validate(input({ count: 2, urls: ['https://publisher.example.test/one.jpg'] })), /для каждого изображения/);
  assert.throws(() => maxPublisher.validate(input({ urls: ['https://'] })), /корректным публичным HTTPS URL/);
  assert.throws(() => maxPublisher.validate(input({ urls: ['https://user:pass@publisher.example.test/a.jpg'] })), /без credentials/);
  assert.throws(() => maxPublisher.validate(input({ count: 13 })), /не более 12/);

  // 6. Existing image success path stays URL-based and one-request, with compiler HTML transport.
  {
    const richDoc={type:'doc',content:[{type:'paragraph',content:[
      {type:'text',text:'MAX <safe> ',marks:[]},
      {type:'text',text:'bold',marks:[{type:'bold'},{type:'underline'}]},
      {type:'text',text:' ',marks:[]},
      {type:'link',attrs:{href:'https://example.test/max?a=1&b=2'},content:[{type:'text',text:'link',marks:[{type:'italic'}]}]}
    ]}]};
    const compiled=compilePlatformText('max',richDoc,'media_caption');
    assert.equal(compiled.transport.kind,'max_html');
    const calls = [];
    globalThis.fetch = async (request, init = {}) => {
      calls.push({ request: String(request), init });
      return json({ message: { body: { mid: 'max-mid-1' }, link: 'https://max.ru/channel/post/1' } });
    };
    const result = await maxPublisher.publish({
      ...input({ count: 2, text: compiled.plainText }),
      textCompilation: compiled
    });
    assert.equal(result.externalId, 'max-mid-1');
    assert.equal(result.externalUrl, 'https://max.ru/channel/post/1');
    assert.equal(calls.length, 1);
    const call = calls[0];
    const url = new URL(call.request);
    assert.equal(url.origin + url.pathname, 'https://platform-api2.max.ru/messages');
    assert.equal(url.searchParams.get('chat_id'), '-100500');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(call.init.headers.Authorization, 'max-test-token');
    const body = JSON.parse(call.init.body);
    assert.equal(body.text, compiled.transport.text);
    assert.equal(body.format, 'html');
    assert.equal(body.text.includes('<safe>'), false);
    assert.equal(body.parse_mode, undefined);
    assert.deepEqual(body.attachments.map((item) => item.payload.url), [
      'https://publisher.example.test/public-media/0.jpg',
      'https://publisher.example.test/public-media/1.jpg'
    ]);
    assert.ok(call.init.signal instanceof AbortSignal);
  }

  // 7. Image 429 is an explicit rejection and safe to retry.
  {
    globalThis.fetch = async () => json({ code: 'rate.limit' }, 429);
    await expectPlatformError(maxPublisher.publish(input()), {
      retryable: true,
      outcomeUnknown: false,
      message: /HTTP 429/
    });
  }

  // 8. Image POST /messages 500 can have an unknown public outcome.
  {
    globalThis.fetch = async () => json({ code: 'internal.error' }, 500);
    await expectPlatformError(maxPublisher.publish(input()), {
      retryable: false,
      outcomeUnknown: true,
      message: /HTTP 500/
    });
  }

  // 9. Image POST /messages transport failure is recovery territory.
  {
    globalThis.fetch = async () => { throw new TypeError('connection dropped'); };
    await expectPlatformError(maxPublisher.publish(input()), {
      retryable: false,
      outcomeUnknown: true,
      message: /MAX POST \/messages/
    });
  }

  // 10. Image success-like response without id cannot prove what happened publicly.
  {
    globalThis.fetch = async () => json({ message: { body: {}, text: 'created maybe' } });
    await expectPlatformError(maxPublisher.publish(input()), {
      retryable: false,
      outcomeUnknown: true,
      message: /не вернул идентификатор/
    });
  }

  // 11. Video happy path: reserve upload -> file-backed multipart upload -> token message.
  {
    const steps = [
      {
        url: 'https://platform-api2.max.ru/uploads?type=video',
        check: ({ init }) => {
          assert.equal(init.method, 'POST');
          assert.equal(init.headers.Authorization, 'max-test-token');
          assert.ok(init.signal instanceof AbortSignal);
        },
        response: {
          url: 'https://omub.okcdn.ru/upload.do?sig=video-test',
          token: 'max-video-token-1'
        }
      },
      {
        url: 'https://omub.okcdn.ru/upload.do?sig=video-test',
        check: ({ init }) => {
          assert.equal(init.method, 'POST');
          assert.ok(init.body instanceof FormData);
          assert.equal(init.headers?.Authorization, undefined, 'bot token must not leak to upload host');
          const data = init.body.get('data');
          assert.ok(data instanceof Blob);
          assert.equal(data.type, 'video/mp4');
          assert.ok(init.signal instanceof AbortSignal);
        },
        response: { retval: 1 }
      },
      {
        url: 'https://platform-api2.max.ru/messages?chat_id=-100500',
        check: ({ init }) => {
          assert.equal(init.headers.Authorization, 'max-test-token');
          const body = JSON.parse(init.body);
          assert.equal(body.text, 'MAX video test');
          assert.equal(body.format, 'html');
          assert.deepEqual(body.attachments, [{ type: 'video', payload: { token: 'max-video-token-1' } }]);
        },
        response: { message: { body: { mid: 'max-video-mid-1' }, link: 'https://max.ru/channel/post/video-1' } }
      }
    ];
    const calls = mockFetch(steps);
    const result = await maxPublisher.publish(videoInput());
    assert.equal(result.externalId, 'max-video-mid-1');
    assert.equal(result.externalUrl, 'https://max.ru/channel/post/video-1');
    assert.equal(calls.length, 3);
    assert.equal(steps.length, 0);
  }

  // 12. MAX 250 MB video limit is enforced before network activity.
  {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run');
    };
    await assert.rejects(
      maxPublisher.publish(videoInput({ media: [{ ...videoMedia, size_bytes: 250 * 1024 * 1024 + 1 }] })),
      /превышает предел 250 MB/
    );
    assert.equal(fetchCalls, 0);
  }

  // 13. Non-H.264 canonical input is rejected before network activity.
  {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run');
    };
    await assert.rejects(
      maxPublisher.publish(videoInput({ media: [{ ...videoMedia, video_codec: 'hevc' }] })),
      /canonical video должен быть H\.264/
    );
    assert.equal(fetchCalls, 0);
  }

  // 14. Missing local video is rejected before POST /uploads.
  {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run');
    };
    const missing = { ...videoMedia, relative_path: 'max-post/missing.mp4' };
    await expectPlatformError(maxPublisher.publish(videoInput({ media: [missing] })), {
      retryable: false,
      outcomeUnknown: false,
      message: /локальное видео недоступно/
    });
    assert.equal(fetchCalls, 0);
  }

  // 15. Reservation 5xx is preparation-only and safe to retry.
  {
    const steps = [{
      url: 'https://platform-api2.max.ru/uploads?type=video',
      status: 503,
      response: { code: 'internal.error' }
    }];
    mockFetch(steps);
    await expectPlatformError(maxPublisher.publish(videoInput()), {
      retryable: true,
      outcomeUnknown: false,
      message: /upload reservation.*подготовительная фаза/
    });
  }

  // 16. Upload URL is restricted to the documented MAX video host to prevent SSRF.
  {
    const steps = [{
      url: 'https://platform-api2.max.ru/uploads?type=video',
      response: { url: 'https://127.0.0.1/upload.do', token: 'do-not-use' }
    }];
    const calls = mockFetch(steps);
    await expectPlatformError(maxPublisher.publish(videoInput()), {
      retryable: false,
      outcomeUnknown: false,
      message: /не соответствует разрешённому HTTPS host omub\.okcdn\.ru/
    });
    assert.equal(calls.length, 1);
    assert.equal(steps.length, 0);
  }

  // 17. Binary upload 5xx is preparation-only and safe to retry.
  {
    const steps = [
      {
        url: 'https://platform-api2.max.ru/uploads?type=video',
        response: { url: 'https://omub.okcdn.ru/upload.do?sig=upload-503', token: 'max-video-token-503' }
      },
      {
        url: 'https://omub.okcdn.ru/upload.do?sig=upload-503',
        status: 503,
        response: { code: 'temporary' }
      }
    ];
    mockFetch(steps);
    await expectPlatformError(maxPublisher.publish(videoInput()), {
      retryable: true,
      outcomeUnknown: false,
      message: /MAX upload video.*подготовительная фаза/
    });
  }

  // 18. attachment.not.ready is an explicit known rejection; retry is safe and must not enter recovery.
  {
    const steps = [
      {
        url: 'https://platform-api2.max.ru/uploads?type=video',
        response: { url: 'https://omub.okcdn.ru/upload.do?sig=not-ready', token: 'max-video-token-not-ready' }
      },
      {
        url: 'https://omub.okcdn.ru/upload.do?sig=not-ready',
        response: { retval: 1 }
      },
      {
        url: 'https://platform-api2.max.ru/messages?chat_id=-100500',
        status: 400,
        response: { code: 'attachment.not.ready', message: 'Key: errors.process.attachment.file.not.processed' }
      }
    ];
    mockFetch(steps);
    await expectPlatformError(maxPublisher.publish(videoInput()), {
      retryable: true,
      outcomeUnknown: false,
      code: 'attachment.not.ready',
      message: /attachment\.not\.ready/
    });
  }

  // 19. Video POST /messages 500 may have created the public message and requires recovery.
  {
    const steps = [
      {
        url: 'https://platform-api2.max.ru/uploads?type=video',
        response: { url: 'https://omub.okcdn.ru/upload.do?sig=message-500', token: 'max-video-token-message-500' }
      },
      {
        url: 'https://omub.okcdn.ru/upload.do?sig=message-500',
        response: { retval: 1 }
      },
      {
        url: 'https://platform-api2.max.ru/messages?chat_id=-100500',
        status: 500,
        response: { code: 'internal.error' }
      }
    ];
    mockFetch(steps);
    await expectPlatformError(maxPublisher.publish(videoInput()), {
      retryable: false,
      outcomeUnknown: true,
      message: /HTTP 500/
    });
  }

  // 20. Video POST /messages transport failure is also an unknown public outcome.
  {
    const steps = [
      {
        url: 'https://platform-api2.max.ru/uploads?type=video',
        response: { url: 'https://omub.okcdn.ru/upload.do?sig=message-network', token: 'max-video-token-network' }
      },
      {
        url: 'https://omub.okcdn.ru/upload.do?sig=message-network',
        response: { retval: 1 }
      },
      {
        url: 'https://platform-api2.max.ru/messages?chat_id=-100500',
        error: new TypeError('connection dropped after message POST')
      }
    ];
    mockFetch(steps);
    await expectPlatformError(maxPublisher.publish(videoInput()), {
      retryable: false,
      outcomeUnknown: true,
      message: /MAX POST \/messages/
    });
  }

  // 21. Video success-like response without message id is unknown and must not auto-retry.
  {
    const steps = [
      {
        url: 'https://platform-api2.max.ru/uploads?type=video',
        response: { url: 'https://omub.okcdn.ru/upload.do?sig=missing-id', token: 'max-video-token-missing-id' }
      },
      {
        url: 'https://omub.okcdn.ru/upload.do?sig=missing-id',
        response: { retval: 1 }
      },
      {
        url: 'https://platform-api2.max.ru/messages?chat_id=-100500',
        response: { message: { body: {}, text: 'created maybe' } }
      }
    ];
    mockFetch(steps);
    await expectPlatformError(maxPublisher.publish(videoInput()), {
      retryable: false,
      outcomeUnknown: true,
      message: /не вернул идентификатор/
    });
  }

  console.log(JSON.stringify({
    ok: true,
    scenarios: 21,
    unicodeBoundary: 4000,
    feedVideoAdapterImplemented: true,
    formatAwarePublicMediaUrls: true,
    videoCapabilityStillLiveGated: true
  }, null, 2));
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}