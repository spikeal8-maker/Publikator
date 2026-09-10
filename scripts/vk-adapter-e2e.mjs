import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-adapter-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'vk-adapter-test-password';
process.env.APP_MASTER_KEY = 'vk-adapter-test-master-key-longer-than-thirty-two-characters';

const { vkPublisher } = await import('../dist/platforms/vk.js');
const { PlatformError } = await import('../dist/platforms/types.js');
const { db } = await import('../dist/db.js');

const relativePath = 'post-vk-test/image.jpg';
const absolutePath = path.join(dataDir, 'media', 'post-vk-test', 'image.jpg');
await fs.mkdir(path.dirname(absolutePath), { recursive: true });
await fs.writeFile(absolutePath, Buffer.from('vk-image-test'));

const baseInput = {
  postId: 'post-vk-test',
  title: 'VK phase test',
  text: 'Тест VK',
  media: [{
    id: 'media-vk',
    post_id: 'post-vk-test',
    original_name: 'image.jpg',
    relative_path: relativePath,
    mime_type: 'image/jpeg',
    size_bytes: 13,
    width: 100,
    height: 100,
    sha256: 'a'.repeat(64),
    created_at: '2026-09-10T00:00:00.000Z',
    sort_order: 0
  }],
  credentials: {
    accessToken: 'test-vk-token',
    groupId: '12345',
    apiVersion: '5.199'
  },
  publicMediaUrls: []
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function apiMethod(url) {
  const match = /\/method\/([^/?]+)/.exec(url);
  return match?.[1] || null;
}

function mockFetch(steps) {
  const calls = [];
  globalThis.fetch = async (request, init = {}) => {
    const url = String(request);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body.entries()) : null;
    const call = { url, method, body, apiMethod: apiMethod(url) };
    calls.push(call);
    const step = steps.shift();
    assert.ok(step, `Unexpected fetch ${method} ${url}`);
    if (step.apiMethod !== undefined) assert.equal(call.apiMethod, step.apiMethod);
    if (step.url) assert.equal(url, step.url);
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

function successPreparationSteps(finalStep) {
  return [
    { apiMethod: 'photos.getWallUploadServer', response: { response: { upload_url: 'https://upload.vk.test/photo' } } },
    { apiMethod: null, url: 'https://upload.vk.test/photo', response: { server: 42, photo: '[1]', hash: 'hash-1' } },
    { apiMethod: 'photos.saveWallPhoto', response: { response: [{ owner_id: -12345, id: 777 }] } },
    finalStep
  ];
}

try {
  // Full happy path reaches wall.post only after all preparation stages.
  {
    const steps = successPreparationSteps({
      apiMethod: 'wall.post',
      check: (call) => {
        assert.equal(call.body.owner_id, '-12345');
        assert.equal(call.body.guid, 'post-vk-test');
        assert.equal(call.body.attachments, 'photo-12345_777');
      },
      response: { response: { post_id: 9001 } }
    });
    const calls = mockFetch(steps);
    const result = await vkPublisher.publish(baseInput);
    assert.equal(result.externalId, '9001');
    assert.equal(result.externalUrl, 'https://vk.com/wall-12345_9001');
    assert.equal(steps.length, 0);
    assert.equal(calls.length, 4);
  }

  // Network failure obtaining upload server is pre-publication: safe retry, never recovery.
  {
    const steps = [{ apiMethod: 'photos.getWallUploadServer', error: new TypeError('network down') }];
    mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(baseInput), {
      retryable: true,
      outcomeUnknown: false,
      message: /подготовительная фаза/
    });
  }

  // HTTP 5xx from the upload host is also pre-publication and safe to retry.
  {
    const steps = [
      { apiMethod: 'photos.getWallUploadServer', response: { response: { upload_url: 'https://upload.vk.test/photo' } } },
      { apiMethod: null, url: 'https://upload.vk.test/photo', status: 503, response: { error: 'temporary' } }
    ];
    mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(baseInput), {
      retryable: true,
      outcomeUnknown: false,
      message: /VK upload image.*подготовительная фаза/
    });
  }

  // HTTP 5xx during saveWallPhoto may create an orphan photo, but cannot create a wall post.
  {
    const steps = [
      { apiMethod: 'photos.getWallUploadServer', response: { response: { upload_url: 'https://upload.vk.test/photo' } } },
      { apiMethod: null, url: 'https://upload.vk.test/photo', response: { server: 42, photo: '[1]', hash: 'hash-1' } },
      { apiMethod: 'photos.saveWallPhoto', status: 503, response: { error: 'temporary' } }
    ];
    mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(baseInput), {
      retryable: true,
      outcomeUnknown: false,
      message: /photos.saveWallPhoto.*подготовительная фаза/
    });
  }

  // An explicit VK API error from wall.post is a known response, not an unknown outcome.
  {
    const steps = successPreparationSteps({
      apiMethod: 'wall.post',
      response: { error: { error_code: 6, error_msg: 'Too many requests per second' } }
    });
    mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(baseInput), {
      retryable: true,
      outcomeUnknown: false,
      message: /VK wall\.post: 6/
    });
  }

  // A transport failure after wall.post starts can have an unknown public outcome.
  {
    const steps = successPreparationSteps({
      apiMethod: 'wall.post',
      error: new TypeError('connection dropped after wall.post')
    });
    mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(baseInput), {
      retryable: false,
      outcomeUnknown: true,
      message: /VK wall\.post/
    });
  }

  // Missing local media happens before any network POST and must never enter recovery.
  {
    const missingInput = {
      ...baseInput,
      media: [{ ...baseInput.media[0], relative_path: 'post-vk-test/missing.jpg' }]
    };
    const steps = [
      { apiMethod: 'photos.getWallUploadServer', response: { response: { upload_url: 'https://upload.vk.test/photo' } } }
    ];
    mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(missingInput), {
      retryable: false,
      outcomeUnknown: false,
      message: /локальное изображение недоступно/
    });
    assert.equal(steps.length, 0);
  }

  console.log(JSON.stringify({ ok: true, scenarios: 7 }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
