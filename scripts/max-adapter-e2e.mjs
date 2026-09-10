import assert from 'node:assert/strict';

const { maxPublisher } = await import('../dist/platforms/max.js');
const { PlatformError } = await import('../dist/platforms/types.js');

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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
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

// Unicode characters, not UTF-16 code units, define the 4000-char boundary.
assert.doesNotThrow(() => maxPublisher.validate(input({ text: '🙂'.repeat(4000) })));
assert.throws(() => maxPublisher.validate(input({ text: '🙂'.repeat(4001) })), /превышает предел 4000/);

// Media and public URLs must remain one-to-one and actually be HTTPS URLs.
assert.throws(() => maxPublisher.validate(input({ count: 2, urls: ['https://publisher.example.test/one.jpg'] })), /для каждого изображения/);
assert.throws(() => maxPublisher.validate(input({ urls: ['https://'] })), /корректным публичным HTTPS URL/);
assert.throws(() => maxPublisher.validate(input({ urls: ['https://user:pass@publisher.example.test/a.jpg'] })), /без credentials/);
assert.throws(() => maxPublisher.validate(input({ count: 13 })), /не более 12/);

// Success: token is only in Authorization, chat_id is the destination, attachments preserve order.
{
  const calls = [];
  globalThis.fetch = async (request, init = {}) => {
    calls.push({ request: String(request), init });
    return json({ message: { body: { mid: 'max-mid-1' }, link: 'https://max.ru/channel/post/1' } });
  };
  const result = await maxPublisher.publish(input({ count: 2 }));
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
  assert.deepEqual(body.attachments.map((item) => item.payload.url), [
    'https://publisher.example.test/public-media/0.jpg',
    'https://publisher.example.test/public-media/1.jpg'
  ]);
  assert.ok(call.init.signal instanceof AbortSignal);
}

// 429 is an explicit rejection and can be retried without assuming a post exists.
{
  globalThis.fetch = async () => json({ code: 'rate.limit' }, 429);
  await expectPlatformError(maxPublisher.publish(input()), {
    retryable: true,
    outcomeUnknown: false,
    message: /HTTP 429/
  });
}

// 500 after starting POST /messages may have an unknown public outcome.
{
  globalThis.fetch = async () => json({ code: 'internal.error' }, 500);
  await expectPlatformError(maxPublisher.publish(input()), {
    retryable: false,
    outcomeUnknown: true,
    message: /HTTP 500/
  });
}

// Transport failure/timeout after POST starts is also recovery territory.
{
  globalThis.fetch = async () => { throw new TypeError('connection dropped'); };
  await expectPlatformError(maxPublisher.publish(input()), {
    retryable: false,
    outcomeUnknown: true,
    message: /MAX POST \/messages/
  });
}

// A success-like response without an external id cannot prove what happened publicly.
{
  globalThis.fetch = async () => json({ message: { body: {}, text: 'created maybe' } });
  await expectPlatformError(maxPublisher.publish(input()), {
    retryable: false,
    outcomeUnknown: true,
    message: /не вернул идентификатор/
  });
}

console.log(JSON.stringify({ ok: true, scenarios: 10, unicodeBoundary: 4000 }, null, 2));
