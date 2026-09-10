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
const { PlatformError } = await import('../dist/platforms/types.js');
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

const media1 = await makeMedia(1);
const media2 = await makeMedia(2);

function input({ text = 'Короткий Telegram текст', media = [media1] } = {}) {
  return {
    postId: 'post-telegram-test',
    title: 'Telegram adapter test',
    text,
    media,
    credentials: { botToken: 'test-telegram-token', chatId: '@test-channel' },
    publicMediaUrls: []
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function telegramMethod(url) {
  const match = /\/bot[^/]+\/(sendPhoto|sendMediaGroup|sendMessage)$/.exec(url);
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
  // Single photo happy path uses caption and has a request timeout signal.
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

  // Media group reads both files before POST and preserves one media group request.
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

  // Missing local media is known before a public request and must never become recovery.
  {
    const missing = { ...media1, relative_path: 'post-telegram-test/missing.jpg' };
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run');
    };
    await expectPlatformError(telegramPublisher.publish(input({ media: [missing] })), {
      retryable: false,
      outcomeUnknown: false,
      message: /локальное изображение недоступно/
    });
    assert.equal(fetchCalls, 0);
  }

  // Explicit 429 rejects the public request and is safe to retry later.
  {
    const steps = [{ telegramMethod: 'sendPhoto', status: 429, response: { ok: false, error_code: 429, description: 'Too Many Requests' } }];
    mockFetch(steps);
    await expectPlatformError(telegramPublisher.publish(input()), {
      retryable: true,
      outcomeUnknown: false,
      message: /HTTP 429/
    });
  }

  // HTTP 5xx after the public POST begins has an unknown public outcome.
  {
    const steps = [{ telegramMethod: 'sendPhoto', status: 503, response: { ok: false, description: 'Unavailable' } }];
    mockFetch(steps);
    await expectPlatformError(telegramPublisher.publish(input()), {
      retryable: false,
      outcomeUnknown: true,
      message: /HTTP 503/
    });
  }

  // Transport/timeout-style failure after public POST begins is recovery territory.
  {
    const steps = [{ telegramMethod: 'sendPhoto', error: new TypeError('connection dropped') }];
    mockFetch(steps);
    await expectPlatformError(telegramPublisher.publish(input()), {
      retryable: false,
      outcomeUnknown: true,
      message: /Telegram sendPhoto/
    });
  }

  // If media is published but the follow-up long-text message fails explicitly, retrying the whole target is still unsafe.
  {
    const longText = 'я'.repeat(1025);
    const steps = [
      {
        telegramMethod: 'sendPhoto',
        check: (call) => assert.equal(call.init.body.get('caption'), ''),
        response: { ok: true, result: { message_id: 301 } }
      },
      {
        telegramMethod: 'sendMessage',
        check: (call) => {
          const body = JSON.parse(String(call.init.body));
          assert.equal(body.text, longText);
          assert.ok(call.init.signal instanceof AbortSignal);
        },
        status: 400,
        response: { ok: false, error_code: 400, description: 'Bad Request' }
      }
    ];
    mockFetch(steps);
    await expectPlatformError(telegramPublisher.publish(input({ text: longText })), {
      retryable: false,
      outcomeUnknown: true,
      message: /media уже опубликовано \(message_id=301\).*повтор всего target заблокирован/
    });
  }

  // Success-like media response without message_id cannot prove a safe idempotent retry.
  {
    const steps = [{ telegramMethod: 'sendPhoto', response: { ok: true, result: {} } }];
    mockFetch(steps);
    await expectPlatformError(telegramPublisher.publish(input()), {
      retryable: false,
      outcomeUnknown: true,
      message: /не вернул message_id/
    });
  }

  console.log(JSON.stringify({ ok: true, scenarios: 8 }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
