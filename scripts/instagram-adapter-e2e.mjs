import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { instagramPublisher } = await import('../dist/platforms/instagram.js');
const { PLATFORM_CAPABILITIES, platformRequiresPublicHttpsMedia } = await import('../dist/platforms/capabilities.js');
const { PlatformError } = await import('../dist/platforms/types.js');
const { compilePlatformText } = await import('../dist/platform-text.js');

const credentials = {
  accessToken: 'test-access-token',
  igUserId: '17841400000000000',
  graphVersion: 'v24.0'
};

function media(id) {
  return {
    id,
    post_id: 'post-instagram-test',
    original_name: `${id}.jpg`,
    relative_path: `post-instagram-test/${id}.jpg`,
    mime_type: 'image/jpeg',
    size_bytes: 128,
    width: 1080,
    height: 1080,
    sha256: id.padEnd(64, '0').slice(0, 64),
    created_at: '2026-09-10T00:00:00.000Z',
    sort_order: 0
  };
}

const videoMedia = {
  id: 'instagram-video-1',
  post_id: 'post-instagram-test',
  original_name: 'clip.mp4',
  relative_path: 'post-instagram-test/clip.mp4',
  mime_type: 'video/mp4',
  size_bytes: 4096,
  width: 1080,
  height: 1920,
  duration_ms: 12_500,
  fps: 30,
  video_codec: 'h264',
  audio_codec: 'aac',
  container: 'mp4',
  poster_asset_id: 'instagram-poster-1',
  sha256: 'v'.repeat(64),
  created_at: '2026-09-10T00:00:00.000Z',
  sort_order: 0
};

function input(urls) {
  return {
    postId: 'post-instagram-test',
    title: 'Instagram adapter test',
    text: 'Тестовый текст',
    media: urls.map((_, index) => ({ ...media(`m${index + 1}`), sort_order: index })),
    credentials,
    publicMediaUrls: urls
  };
}

function videoInput(overrides = {}) {
  return {
    postId: 'post-instagram-test',
    title: 'Instagram video adapter test',
    text: 'Тестовый Reel',
    media: [videoMedia],
    credentials,
    publicMediaUrls: ['https://publisher.example.test/public-media/clip.mp4'],
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
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body.entries()) : null;
    calls.push({ url, method, body });
    const step = steps.shift();
    assert.ok(step, `Unexpected fetch ${method} ${url}`);
    if (step.method) assert.equal(method, step.method);
    if (step.path) assert.equal(new URL(url).pathname, step.path);
    if (step.check) step.check({ url, method, body });
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

assert.equal(PLATFORM_CAPABILITIES.instagram.supportsVideo, false, 'Instagram video capability must remain gated until live acceptance');
assert.equal(PLATFORM_CAPABILITIES.instagram.supportsStories, false);
assert.equal(PLATFORM_CAPABILITIES.instagram.supportsShortVideo, false);
assert.equal(PLATFORM_CAPABILITIES.instagram.verification.richMediaPendingLiveAcceptance, true);
assert.equal(platformRequiresPublicHttpsMedia('instagram', 'VIDEO'), true);

// 1. Single image: compiler plain caption -> IN_PROGRESS -> FINISHED -> media_publish.
{
  const richDoc={type:'doc',content:[{type:'paragraph',content:[
    {type:'text',text:'Instagram ',marks:[]},
    {type:'text',text:'bold',marks:[{type:'bold'},{type:'underline'}]},
    {type:'text',text:' ',marks:[]},
    {type:'link',attrs:{href:'https://example.test/ig'},content:[{type:'text',text:'link',marks:[]}]}
  ]}]};
  const compiled=compilePlatformText('instagram',richDoc,'media_caption');
  assert.equal(compiled.transport.kind,'plain');
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', check: ({ body }) => {
      assert.equal(body.caption,compiled.transport.text);
      assert.equal(body.caption.includes('**'),false);
      assert.equal(body.caption.includes('<strong>'),false);
    }, response: { id: 'container-single' } },
    { method: 'GET', path: '/v24.0/container-single', response: { status_code: 'IN_PROGRESS', status: 'Processing' } },
    { method: 'GET', path: '/v24.0/container-single', response: { status_code: 'FINISHED', status: 'Ready' } },
    { method: 'POST', path: '/v24.0/17841400000000000/media_publish', check: ({ body }) => assert.equal(body.creation_id, 'container-single'), response: { id: 'published-single' } }
  ];
  const calls = mockFetch(steps);
  const result = await instagramPublisher.publish({
    ...input(['https://publisher.example.test/public-media/a.jpg']),
    text:compiled.plainText,
    textCompilation:compiled
  });
  assert.equal(result.externalId, 'published-single');
  assert.equal(steps.length, 0);
  assert.equal(calls.length, 4);
}

// 2. Carousel: every child must be FINISHED before parent is created; parent must be FINISHED before publish.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', check: ({ body }) => { assert.equal(body.image_url.endsWith('/one.jpg'), true); assert.equal(body.is_carousel_item, 'true'); }, response: { id: 'child-1' } },
    { method: 'GET', path: '/v24.0/child-1', response: { status_code: 'FINISHED' } },
    { method: 'POST', path: '/v24.0/17841400000000000/media', check: ({ body }) => { assert.equal(body.image_url.endsWith('/two.jpg'), true); assert.equal(body.is_carousel_item, 'true'); }, response: { id: 'child-2' } },
    { method: 'GET', path: '/v24.0/child-2', response: { status_code: 'FINISHED' } },
    { method: 'POST', path: '/v24.0/17841400000000000/media', check: ({ body }) => { assert.equal(body.media_type, 'CAROUSEL'); assert.equal(body.children, 'child-1,child-2'); }, response: { id: 'parent-carousel' } },
    { method: 'GET', path: '/v24.0/parent-carousel', response: { status_code: 'FINISHED' } },
    { method: 'POST', path: '/v24.0/17841400000000000/media_publish', check: ({ body }) => assert.equal(body.creation_id, 'parent-carousel'), response: { id: 'published-carousel' } }
  ];
  const calls = mockFetch(steps);
  const result = await instagramPublisher.publish(input([
    'https://publisher.example.test/public-media/one.jpg',
    'https://publisher.example.test/public-media/two.jpg'
  ]));
  assert.equal(result.externalId, 'published-carousel');
  assert.equal(steps.length, 0);
  assert.equal(calls.length, 7);
}

// 3. Image container creation failure is preparation-only and safe to retry.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', error: new TypeError('socket reset during container creation') }
  ];
  mockFetch(steps);
  await expectPlatformError(
    instagramPublisher.publish(input(['https://publisher.example.test/public-media/a.jpg'])),
    { retryable: true, outcomeUnknown: false, message: /не является публичной публикацией/ }
  );
}

// 4. Explicit container ERROR is known and not an unknown public outcome.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', response: { id: 'container-error' } },
    { method: 'GET', path: '/v24.0/container-error', response: { status_code: 'ERROR', status: 'Media fetch failed' } }
  ];
  mockFetch(steps);
  await expectPlatformError(
    instagramPublisher.publish(input(['https://publisher.example.test/public-media/a.jpg'])),
    { retryable: false, outcomeUnknown: false, message: /container-error: ERROR.*Media fetch failed/ }
  );
}

// 5. Once image media_publish starts, transport failure has unknown public outcome.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', response: { id: 'container-publish-unknown' } },
    { method: 'GET', path: '/v24.0/container-publish-unknown', response: { status_code: 'FINISHED' } },
    { method: 'POST', path: '/v24.0/17841400000000000/media_publish', error: new TypeError('connection dropped after POST') }
  ];
  mockFetch(steps);
  await expectPlatformError(
    instagramPublisher.publish(input(['https://publisher.example.test/public-media/a.jpg'])),
    { retryable: false, outcomeUnknown: true, message: /media_publish/ }
  );
}

// 6. FEED/VIDEO is created as a Reel shared to feed, waits for FINISHED, then publishes once.
{
  const steps = [
    {
      method: 'POST',
      path: '/v24.0/17841400000000000/media',
      check: ({ body }) => {
        assert.equal(body.media_type, 'REELS');
        assert.equal(body.video_url, 'https://publisher.example.test/public-media/clip.mp4');
        assert.equal(body.caption, 'Тестовый Reel');
        assert.equal(body.share_to_feed, 'true');
        assert.equal(body.access_token, 'test-access-token');
      },
      response: { id: 'reel-container-1' }
    },
    { method: 'GET', path: '/v24.0/reel-container-1', response: { status_code: 'IN_PROGRESS', status: 'Processing' } },
    { method: 'GET', path: '/v24.0/reel-container-1', response: { status_code: 'FINISHED', status: 'Ready' } },
    {
      method: 'POST',
      path: '/v24.0/17841400000000000/media_publish',
      check: ({ body }) => {
        assert.equal(body.creation_id, 'reel-container-1');
        assert.equal(body.access_token, 'test-access-token');
      },
      response: { id: 'instagram-reel-media-1' }
    }
  ];
  const calls = mockFetch(steps);
  const result = await instagramPublisher.publish(videoInput());
  assert.equal(result.externalId, 'instagram-reel-media-1');
  assert.equal(calls.length, 4);
  assert.equal(steps.length, 0);
}

// 7. Video URL must be one public HTTPS URL without embedded credentials; validation performs no network call.
{
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  };
  await assert.rejects(
    instagramPublisher.publish(videoInput({ publicMediaUrls: ['http://publisher.example.test/clip.mp4'] })),
    /публичный HTTPS video_url/
  );
  await assert.rejects(
    instagramPublisher.publish(videoInput({ publicMediaUrls: ['https://user:pass@publisher.example.test/clip.mp4'] })),
    /публичный HTTPS video_url/
  );
  assert.equal(fetchCalls, 0);
}

// 8. FEED/VIDEO remains one MP4 asset only.
{
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  };
  await assert.rejects(
    instagramPublisher.publish(videoInput({ media: [videoMedia, { ...videoMedia, id: 'instagram-video-2' }] })),
    /ровно один video asset/
  );
  await assert.rejects(
    instagramPublisher.publish(videoInput({ media: [{ ...videoMedia, mime_type: 'video/webm' }] })),
    /требует video\/mp4/
  );
  assert.equal(fetchCalls, 0);
}

// 9. Publikator canonical H.264/AAC/MP4 profile is enforced even though Meta accepts a broader input set.
{
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  };
  await assert.rejects(
    instagramPublisher.publish(videoInput({ media: [{ ...videoMedia, video_codec: 'hevc' }] })),
    /canonical video должен быть H\.264/
  );
  await assert.rejects(
    instagramPublisher.publish(videoInput({ media: [{ ...videoMedia, audio_codec: 'opus' }] })),
    /canonical audio должен быть AAC/
  );
  await assert.rejects(
    instagramPublisher.publish(videoInput({ media: [{ ...videoMedia, container: 'mov' }] })),
    /container должен быть MP4/
  );
  assert.equal(fetchCalls, 0);
}

// 10. Current Reel size/duration/FPS/width limits are rejected before the first Graph request.
{
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  };
  await assert.rejects(
    instagramPublisher.publish(videoInput({ media: [{ ...videoMedia, size_bytes: 1024 * 1024 * 1024 + 1 }] })),
    /превышает предел 1 GB/
  );
  await assert.rejects(
    instagramPublisher.publish(videoInput({ media: [{ ...videoMedia, duration_ms: 2_999 }] })),
    /короче 3 секунд/
  );
  await assert.rejects(
    instagramPublisher.publish(videoInput({ media: [{ ...videoMedia, duration_ms: 900_001 }] })),
    /длиннее 900 секунд/
  );
  await assert.rejects(
    instagramPublisher.publish(videoInput({ media: [{ ...videoMedia, fps: 22 }] })),
    /вне диапазона 23-60/
  );
  await assert.rejects(
    instagramPublisher.publish(videoInput({ media: [{ ...videoMedia, width: 1921 }] })),
    /превышает 1920px/
  );
  assert.equal(fetchCalls, 0);
}

// 11. Reel container 5xx happens before public publication and is safe to retry.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', status: 503, response: { error: { message: 'temporary' } } }
  ];
  mockFetch(steps);
  await expectPlatformError(
    instagramPublisher.publish(videoInput()),
    { retryable: true, outcomeUnknown: false, message: /не является публичной публикацией.*HTTP 503/ }
  );
}

// 12. Reel processing ERROR is a known pre-publish failure.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', response: { id: 'reel-container-error' } },
    { method: 'GET', path: '/v24.0/reel-container-error', response: { status_code: 'ERROR', status: 'Video fetch or processing failed' } }
  ];
  mockFetch(steps);
  await expectPlatformError(
    instagramPublisher.publish(videoInput()),
    { retryable: false, outcomeUnknown: false, message: /reel-container-error: ERROR.*processing failed/ }
  );
}

// 13. Reel media_publish 5xx may already have created the public Reel and therefore requires recovery.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', response: { id: 'reel-container-publish-500' } },
    { method: 'GET', path: '/v24.0/reel-container-publish-500', response: { status_code: 'FINISHED' } },
    { method: 'POST', path: '/v24.0/17841400000000000/media_publish', status: 503, response: { error: { message: 'temporary' } } }
  ];
  mockFetch(steps);
  await expectPlatformError(
    instagramPublisher.publish(videoInput()),
    { retryable: false, outcomeUnknown: true, message: /media_publish.*HTTP 503/ }
  );
}

// 14. Reel media_publish transport failure is also an unknown public outcome.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', response: { id: 'reel-container-publish-network' } },
    { method: 'GET', path: '/v24.0/reel-container-publish-network', response: { status_code: 'FINISHED' } },
    { method: 'POST', path: '/v24.0/17841400000000000/media_publish', error: new TypeError('connection dropped after Reel publish') }
  ];
  mockFetch(steps);
  await expectPlatformError(
    instagramPublisher.publish(videoInput()),
    { retryable: false, outcomeUnknown: true, message: /media_publish/ }
  );
}

// 15. A success-like media_publish response without stable media id cannot be auto-retried.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', response: { id: 'reel-container-missing-id' } },
    { method: 'GET', path: '/v24.0/reel-container-missing-id', response: { status_code: 'FINISHED' } },
    { method: 'POST', path: '/v24.0/17841400000000000/media_publish', response: { success: true } }
  ];
  mockFetch(steps);
  await expectPlatformError(
    instagramPublisher.publish(videoInput()),
    { retryable: false, outcomeUnknown: true, message: /media id отсутствует/ }
  );
}

console.log(JSON.stringify({
  ok: true,
  scenarios: 15,
  feedVideoAdapterImplemented: true,
  reelShareToFeed: true,
  publicHttpsVideoUrlRequired: true,
  videoCapabilityStillLiveGated: true
}, null, 2));
