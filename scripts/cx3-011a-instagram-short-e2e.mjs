import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { instagramPublisher } = await import('../dist/platforms/instagram.js');
const { PLATFORM_CAPABILITIES, platformRequiresPublicHttpsMedia } = await import('../dist/platforms/capabilities.js');
const { PlatformError } = await import('../dist/platforms/types.js');

const credentials = {
  accessToken: 'test-access-token',
  igUserId: '17841400000000000',
  graphVersion: 'v24.0'
};

const videoMedia = {
  id: 'instagram-short-1',
  post_id: 'post-instagram-short-test',
  original_name: 'short.mp4',
  relative_path: 'post-instagram-short-test/short.mp4',
  mime_type: 'video/mp4',
  size_bytes: 4096,
  width: 1080,
  height: 1920,
  duration_ms: 12_500,
  fps: 30,
  video_codec: 'h264',
  audio_codec: 'aac',
  container: 'mp4',
  poster_asset_id: 'instagram-short-poster-1',
  sha256: 'a'.repeat(64),
  created_at: '2026-09-14T00:00:00.000Z',
  sort_order: 0
};

function shortInput(overrides = {}) {
  return {
    postId: 'post-instagram-short-test',
    title: 'Instagram Short adapter test',
    text: 'Тестовый Short',
    media: [videoMedia],
    credentials,
    publicMediaUrls: ['https://publisher.example.test/public-media/short.mp4'],
    publicationKind: 'SHORT',
    contentFormat: 'VERTICAL_VIDEO',
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

assert.equal(PLATFORM_CAPABILITIES.instagram.supportsShortVideo, false, 'Instagram Short capability must remain live-gated');
assert.equal(PLATFORM_CAPABILITIES.instagram.supportsVideo, false, 'Instagram video capability must remain live-gated');
assert.equal(PLATFORM_CAPABILITIES.instagram.verification.richMediaPendingLiveAcceptance, true);
assert.equal(platformRequiresPublicHttpsMedia('instagram', 'VERTICAL_VIDEO'), true);

// 1. SHORT/VERTICAL_VIDEO uses the existing Reel container flow but stays out of Feed.
{
  const steps = [
    {
      method: 'POST',
      path: '/v24.0/17841400000000000/media',
      check: ({ body }) => {
        assert.equal(body.media_type, 'REELS');
        assert.equal(body.video_url, 'https://publisher.example.test/public-media/short.mp4');
        assert.equal(body.caption, 'Тестовый Short');
        assert.equal(body.share_to_feed, 'false');
        assert.equal(body.access_token, 'test-access-token');
      },
      response: { id: 'short-container-1' }
    },
    { method: 'GET', path: '/v24.0/short-container-1', response: { status_code: 'FINISHED', status: 'Ready' } },
    {
      method: 'POST',
      path: '/v24.0/17841400000000000/media_publish',
      check: ({ body }) => assert.equal(body.creation_id, 'short-container-1'),
      response: { id: 'instagram-short-media-1' }
    }
  ];
  const calls = mockFetch(steps);
  const result = await instagramPublisher.publish(shortInput());
  assert.equal(result.externalId, 'instagram-short-media-1');
  assert.equal(calls.length, 3);
  assert.equal(steps.length, 0);
}

// 2. Publication kind and media composition cannot be crossed silently.
{
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  };
  await assert.rejects(
    instagramPublisher.publish(shortInput({ contentFormat: 'VIDEO' })),
    /VIDEO поддерживается только как FEED\/VIDEO/
  );
  await assert.rejects(
    instagramPublisher.publish(shortInput({ publicationKind: 'FEED' })),
    /VERTICAL_VIDEO поддерживается только как SHORT\/VERTICAL_VIDEO/
  );
  assert.equal(fetchCalls, 0);
}

// 3. Publikator VERTICAL_VIDEO semantics reject horizontal media before Graph API.
{
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  };
  await assert.rejects(
    instagramPublisher.publish(shortInput({ media: [{ ...videoMedia, width: 1920, height: 1080 }] })),
    /должен быть вертикальным/
  );
  assert.equal(fetchCalls, 0);
}

// 4. Meta must be able to fetch exactly one credential-free public HTTPS video URL.
{
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  };
  await assert.rejects(
    instagramPublisher.publish(shortInput({ publicMediaUrls: ['http://publisher.example.test/public-media/short.mp4'] })),
    /публичный HTTPS video_url/
  );
  await assert.rejects(
    instagramPublisher.publish(shortInput({ publicMediaUrls: ['https://user:pass@publisher.example.test/public-media/short.mp4'] })),
    /публичный HTTPS video_url/
  );
  assert.equal(fetchCalls, 0);
}

// 5. Container creation failure is pre-publication and safe to retry.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', status: 503, response: { error: { message: 'temporary' } } }
  ];
  mockFetch(steps);
  await expectPlatformError(
    instagramPublisher.publish(shortInput()),
    { retryable: true, outcomeUnknown: false, message: /не является публичной публикацией.*HTTP 503/ }
  );
}

// 6. Once media_publish starts, a transport loss has unknown public outcome and must not auto-retry.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', response: { id: 'short-container-unknown' } },
    { method: 'GET', path: '/v24.0/short-container-unknown', response: { status_code: 'FINISHED' } },
    { method: 'POST', path: '/v24.0/17841400000000000/media_publish', error: new TypeError('connection dropped after Short publish') }
  ];
  mockFetch(steps);
  await expectPlatformError(
    instagramPublisher.publish(shortInput()),
    { retryable: false, outcomeUnknown: true, message: /media_publish/ }
  );
}

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-011A',
  scenarios: 6,
  instagramShortViaReel: true,
  shareToFeedFalse: true,
  verticalSemanticGuard: true,
  publicHttpsVideoUrlRequired: true,
  recoveryBoundaryPreserved: true,
  shortCapabilityStillLiveGated: true
}, null, 2));
