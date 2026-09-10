import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { instagramPublisher } = await import('../dist/platforms/instagram.js');
const { PlatformError } = await import('../dist/platforms/types.js');

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

function input(urls) {
  return {
    postId: 'post-instagram-test',
    title: 'Instagram adapter test',
    text: 'Тестовый текст',
    media: urls.map((_, index) => ({ ...media(`m${index + 1}`), sort_order: index })),
    credentials: {
      accessToken: 'test-access-token',
      igUserId: '17841400000000000',
      graphVersion: 'v24.0'
    },
    publicMediaUrls: urls
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

// Single image: IN_PROGRESS -> FINISHED -> media_publish.
{
  const steps = [
    { method: 'POST', path: '/v24.0/17841400000000000/media', response: { id: 'container-single' } },
    { method: 'GET', path: '/v24.0/container-single', response: { status_code: 'IN_PROGRESS', status: 'Processing' } },
    { method: 'GET', path: '/v24.0/container-single', response: { status_code: 'FINISHED', status: 'Ready' } },
    { method: 'POST', path: '/v24.0/17841400000000000/media_publish', check: ({ body }) => assert.equal(body.creation_id, 'container-single'), response: { id: 'published-single' } }
  ];
  const calls = mockFetch(steps);
  const result = await instagramPublisher.publish(input(['https://publisher.example.test/public-media/a.jpg']));
  assert.equal(result.externalId, 'published-single');
  assert.equal(steps.length, 0);
  assert.equal(calls.length, 4);
}

// Carousel: every child must be FINISHED before parent is created; parent must be FINISHED before publish.
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

// Failure before media_publish is safe to retry: a container may exist, but no public post exists yet.
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

// Explicit container ERROR is not retryable automatically and is not an unknown public outcome.
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

// Once media_publish starts, a transport failure has unknown public outcome and must enter recovery.
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

console.log(JSON.stringify({ ok: true, scenarios: 5 }, null, 2));
