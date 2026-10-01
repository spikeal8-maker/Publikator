import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-key-03-publisher-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'key-03-publisher-password';
process.env.APP_MASTER_KEY = 'key-03-publisher-master-key-longer-than-thirty-two-characters';

const { vkPublisher } = await import('../dist/platforms/vk.js');
const { PlatformError } = await import('../dist/platforms/types.js');
const { db } = await import('../dist/db.js');

const mediaDir = path.join(dataDir, 'media', 'key-03');
await fs.mkdir(mediaDir, { recursive: true });
await fs.writeFile(path.join(mediaDir, 'a.jpg'), Buffer.from('album-image-a'));
await fs.writeFile(path.join(mediaDir, 'b.jpg'), Buffer.from('album-image-b'));

const mediaA = {
  id: 'media-a',
  post_id: 'post-key-03',
  original_name: 'a.jpg',
  relative_path: 'key-03/a.jpg',
  mime_type: 'image/jpeg',
  size_bytes: 13,
  width: 100,
  height: 100,
  sha256: 'a'.repeat(64),
  created_at: '2026-10-01T00:00:00.000Z',
  sort_order: 0
};
const mediaB = {
  ...mediaA,
  id: 'media-b',
  original_name: 'b.jpg',
  relative_path: 'key-03/b.jpg',
  sha256: 'b'.repeat(64),
  sort_order: 1
};

const credentials = {
  accessToken: 'album-user-token',
  apiVersion: '5.199',
  authKind: 'USER',
  destinationKind: 'COMMUNITY',
  groupId: '12345',
  albumId: '777',
  imageUploadMode: 'ALBUM'
};

function input(overrides = {}) {
  return {
    postId: 'post-key-03',
    title: 'KEY-03',
    text: 'Album test',
    publicationKind: 'FEED',
    contentFormat: 'IMAGE',
    media: [mediaA],
    credentials,
    publicMediaUrls: [],
    ...overrides
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function apiMethod(url) {
  return /\/method\/([^/?]+)/.exec(url)?.[1] || null;
}

function mockFetch(steps) {
  const calls = [];
  globalThis.fetch = async (request, init = {}) => {
    const url = String(request);
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body.entries()) : null;
    const form = init.body instanceof FormData ? init.body : null;
    const call = { url, body, form, apiMethod: apiMethod(url), init };
    calls.push(call);
    const step = steps.shift();
    assert.ok(step, `Unexpected fetch ${url}`);
    if (step.apiMethod !== undefined) assert.equal(call.apiMethod, step.apiMethod);
    if (step.url) assert.equal(url, step.url);
    if (step.check) await step.check(call);
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

function getServerStep(uploadUrl) {
  return {
    apiMethod: 'photos.getUploadServer',
    check: (call) => {
      assert.equal(call.body.album_id, '777');
      assert.equal(call.body.group_id, '12345');
      assert.equal(call.body.access_token, 'album-user-token');
    },
    response: { response: { upload_url: uploadUrl } }
  };
}

function uploadStep(uploadUrl, expectedText, server, photosList, hash) {
  return {
    apiMethod: null,
    url: uploadUrl,
    check: async (call) => {
      assert.ok(call.form instanceof FormData);
      const file = call.form.get('file1');
      assert.ok(file instanceof Blob);
      assert.equal(await file.text(), expectedText);
      assert.equal(call.form.get('photo'), null);
    },
    response: { server, photos_list: photosList, hash }
  };
}

function saveStep(server, photosList, hash, ownerId, photoId) {
  return {
    apiMethod: 'photos.save',
    check: (call) => {
      assert.equal(call.body.album_id, '777');
      assert.equal(call.body.group_id, '12345');
      assert.equal(call.body.server, String(server));
      assert.equal(call.body.photos_list, photosList);
      assert.equal(call.body.hash, hash);
    },
    response: { response: [{ owner_id: ownerId, id: photoId }] }
  };
}

function wallCalls(calls) {
  return calls.filter((call) => call.apiMethod === 'wall.post').length;
}

try {
  {
    const steps = [
      getServerStep('https://upload.vk.test/album-a'),
      uploadStep('https://upload.vk.test/album-a', 'album-image-a', 41, '[{"photo":"a"}]', 'hash-a'),
      saveStep(41, '[{"photo":"a"}]', 'hash-a', -12345, 888),
      getServerStep('https://upload.vk.test/album-b'),
      uploadStep('https://upload.vk.test/album-b', 'album-image-b', 42, '[{"photo":"b"}]', 'hash-b'),
      saveStep(42, '[{"photo":"b"}]', 'hash-b', -12345, 889),
      {
        apiMethod: 'wall.post',
        check: (call) => {
          assert.equal(call.body.owner_id, '-12345');
          assert.equal(call.body.from_group, '1');
          assert.equal(call.body.attachments, 'photo-12345_888,photo-12345_889');
          assert.equal(call.body.guid, 'post-key-03:-12345');
        },
        response: { response: { post_id: 9901 } }
      }
    ];
    const calls = mockFetch(steps);
    const result = await vkPublisher.publish(input({
      contentFormat: 'CAROUSEL',
      media: [mediaA, mediaB]
    }));
    assert.equal(result.externalId, '9901');
    assert.equal(wallCalls(calls), 1);
    assert.equal(calls.filter((call) => call.apiMethod === 'photos.getWallUploadServer').length, 0);
    assert.equal(steps.length, 0);
  }

  {
    const steps = [{ apiMethod: 'photos.getUploadServer', error: new TypeError('network down') }];
    const calls = mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(input()), {
      retryable: true,
      outcomeUnknown: false,
      message: /photos\.getUploadServer.*подготовительная фаза/
    });
    assert.equal(wallCalls(calls), 0);
  }

  {
    const steps = [
      getServerStep('https://upload.vk.test/album-503'),
      { apiMethod: null, url: 'https://upload.vk.test/album-503', status: 503, response: { error: 'temporary' } }
    ];
    const calls = mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(input()), {
      retryable: true,
      outcomeUnknown: false,
      message: /VK upload album image.*подготовительная фаза/
    });
    assert.equal(wallCalls(calls), 0);
  }

  {
    const steps = [
      getServerStep('https://upload.vk.test/album-save-503'),
      uploadStep('https://upload.vk.test/album-save-503', 'album-image-a', 43, '[{"photo":"c"}]', 'hash-c'),
      { apiMethod: 'photos.save', status: 503, response: { error: 'temporary' } }
    ];
    const calls = mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(input()), {
      retryable: true,
      outcomeUnknown: false,
      message: /photos\.save.*подготовительная фаза/
    });
    assert.equal(wallCalls(calls), 0);
  }

  {
    const steps = [
      getServerStep('https://upload.vk.test/album-invalid-save'),
      uploadStep('https://upload.vk.test/album-invalid-save', 'album-image-a', 44, '[{"photo":"d"}]', 'hash-d'),
      { apiMethod: 'photos.save', response: { response: [] } }
    ];
    const calls = mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(input()), {
      retryable: false,
      outcomeUnknown: false,
      message: /photos\.save вернул неожиданный ответ/
    });
    assert.equal(wallCalls(calls), 0);
  }

  {
    const steps = [
      getServerStep('https://upload.vk.test/album-wall-fail'),
      uploadStep('https://upload.vk.test/album-wall-fail', 'album-image-a', 45, '[{"photo":"e"}]', 'hash-e'),
      saveStep(45, '[{"photo":"e"}]', 'hash-e', -12345, 890),
      { apiMethod: 'wall.post', error: new TypeError('connection dropped after wall.post') }
    ];
    const calls = mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(input()), {
      retryable: false,
      outcomeUnknown: true,
      message: /VK wall\.post/
    });
    assert.equal(wallCalls(calls), 1);
  }

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'KEY-03-ALBUM-PUBLISHER',
    multipartField: 'file1',
    photosSaveAttachment: true,
    existingWallPostReused: true,
    deterministicAlbumMode: true,
    realPublications: 0
  }));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
