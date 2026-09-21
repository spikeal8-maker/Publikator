import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-adapter-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'vk-adapter-test-password';
process.env.APP_MASTER_KEY = 'vk-adapter-test-master-key-longer-than-thirty-two-characters';

const { vkPublisher, resolveVkDestination } = await import('../dist/platforms/vk.js');
const { PLATFORM_CAPABILITIES } = await import('../dist/platforms/capabilities.js');
const { PlatformError } = await import('../dist/platforms/types.js');
const { compilePlatformText } = await import('../dist/platform-text.js');
const { db } = await import('../dist/db.js');

const imageRelativePath = 'post-vk-test/image.jpg';
const imageAbsolutePath = path.join(dataDir, 'media', imageRelativePath);
await fs.mkdir(path.dirname(imageAbsolutePath), { recursive: true });
await fs.writeFile(imageAbsolutePath, Buffer.from('vk-image-test'));

const videoRelativePath = 'post-vk-test/video.mp4';
const videoAbsolutePath = path.join(dataDir, 'media', videoRelativePath);
await fs.writeFile(videoAbsolutePath, Buffer.from('vk-video-test-fixture'));

const credentials = {
  accessToken: 'test-vk-token',
  groupId: '12345',
  apiVersion: '5.199'
};

const imageMedia = {
  id: 'media-vk',
  post_id: 'post-vk-test',
  original_name: 'image.jpg',
  relative_path: imageRelativePath,
  mime_type: 'image/jpeg',
  size_bytes: 13,
  width: 100,
  height: 100,
  sha256: 'a'.repeat(64),
  created_at: '2026-09-10T00:00:00.000Z',
  sort_order: 0
};

const videoMedia = {
  id: 'video-media-vk',
  post_id: 'post-vk-test',
  original_name: 'video.mp4',
  relative_path: videoRelativePath,
  mime_type: 'video/mp4',
  size_bytes: 21,
  width: 1080,
  height: 1920,
  duration_ms: 12_500,
  fps: 30,
  video_codec: 'h264',
  audio_codec: 'aac',
  container: 'mp4',
  poster_asset_id: 'poster-vk',
  sha256: 'b'.repeat(64),
  created_at: '2026-09-10T00:00:00.000Z',
  sort_order: 0
};

const baseInput = {
  postId: 'post-vk-test',
  title: 'VK phase test',
  text: 'Тест VK',
  media: [imageMedia],
  credentials,
  publicMediaUrls: []
};

function videoInput(overrides = {}) {
  return {
    ...baseInput,
    publicationKind: 'FEED',
    contentFormat: 'VIDEO',
    media: [videoMedia],
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
  const match = /\/method\/([^/?]+)/.exec(url);
  return match?.[1] || null;
}

function mockFetch(steps) {
  const calls = [];
  globalThis.fetch = async (request, init = {}) => {
    const url = String(request);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body.entries()) : null;
    const form = init.body instanceof FormData ? init.body : null;
    const call = { url, method, body, form, apiMethod: apiMethod(url), init };
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

function successImagePreparationSteps(finalStep) {
  return [
    {
      apiMethod: 'photos.getWallUploadServer',
      check: (call) => assert.equal(call.body.group_id, '12345'),
      response: { response: { upload_url: 'https://upload.vk.test/photo' } }
    },
    { apiMethod: null, url: 'https://upload.vk.test/photo', response: { server: 42, photo: '[1]', hash: 'hash-1' } },
    {
      apiMethod: 'photos.saveWallPhoto',
      check: (call) => {
        assert.equal(call.body.group_id, '12345');
        assert.equal(call.body.user_id, undefined);
      },
      response: { response: [{ owner_id: -12345, id: 777 }] }
    },
    finalStep
  ];
}

function successVideoPreparationSteps(finalStep) {
  return [
    {
      apiMethod: 'video.save',
      check: (call) => {
        assert.equal(call.body.group_id, '12345');
        assert.equal(call.body.wallpost, '0');
        assert.equal(call.body.name, 'VK phase test');
        assert.equal(call.body.v, '5.199');
      },
      response: {
        response: {
          upload_url: 'https://upload.vk.test/video',
          owner_id: -12345,
          video_id: 888,
          title: 'VK phase test'
        }
      }
    },
    {
      apiMethod: null,
      url: 'https://upload.vk.test/video',
      check: (call) => {
        assert.ok(call.form instanceof FormData);
        const video = call.form.get('video_file');
        assert.ok(video instanceof Blob);
        assert.equal(video.type, 'video/mp4');
        assert.ok(call.init.signal instanceof AbortSignal);
      },
      response: { size: 21, video_id: 888 }
    },
    finalStep
  ];
}

try {
  assert.equal(PLATFORM_CAPABILITIES.vk.supportsVideo, false, 'VK video capability must remain gated until live acceptance');
  assert.equal(PLATFORM_CAPABILITIES.vk.supportsStories, false);
  assert.equal(PLATFORM_CAPABILITIES.vk.supportsShortVideo, false);
  assert.equal(PLATFORM_CAPABILITIES.vk.verification.richMediaPendingLiveAcceptance, true);
  assert.deepEqual(resolveVkDestination(credentials), { kind: 'COMMUNITY', id: '12345', ownerId: '-12345' },
    'legacy groupId credentials without destinationKind must remain COMMUNITY');

  // 1. Image happy path uses exact compiler plain output; no fake Markdown/HTML.
  {
    const richDoc={type:'doc',content:[{type:'paragraph',content:[
      {type:'text',text:'VK ',marks:[]},
      {type:'text',text:'bold',marks:[{type:'bold'}]},
      {type:'text',text:' ',marks:[]},
      {type:'link',attrs:{href:'https://example.test/vk'},content:[{type:'text',text:'link',marks:[]}]}
    ]}]};
    const compiled=compilePlatformText('vk',richDoc,'media_caption');
    assert.equal(compiled.transport.kind,'plain');
    const steps = successImagePreparationSteps({
      apiMethod: 'wall.post',
      check: (call) => {
        assert.equal(call.body.owner_id, '-12345');
        assert.equal(call.body.guid, 'post-vk-test:-12345');
        assert.equal(call.body.attachments, 'photo-12345_777');
        assert.equal(call.body.message, compiled.transport.text);
        assert.equal(call.body.message.includes('**'), false);
        assert.equal(call.body.message.includes('<strong>'), false);
      },
      response: { response: { post_id: 9001 } }
    });
    const calls = mockFetch(steps);
    const result = await vkPublisher.publish({
      ...baseInput,
      text: compiled.plainText,
      textCompilation: compiled
    });
    assert.equal(result.externalId, '9001');
    assert.equal(result.externalUrl, 'https://vk.com/wall-12345_9001');
    assert.equal(steps.length, 0);
    assert.equal(calls.length, 4);
  }

  // 2. Image upload-server network error is pre-publication and safe to retry.
  {
    const steps = [{ apiMethod: 'photos.getWallUploadServer', error: new TypeError('network down') }];
    mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(baseInput), {
      retryable: true,
      outcomeUnknown: false,
      message: /подготовительная фаза/
    });
  }

  // 3. Image upload host 5xx is pre-publication and safe to retry.
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

  // 4. photos.saveWallPhoto 5xx may leave orphan media but cannot create a wall post.
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

  // 5. Explicit VK wall.post error is known, not an unknown outcome.
  {
    const steps = successImagePreparationSteps({
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

  // 6. Transport failure after wall.post starts can have an unknown public outcome.
  {
    const steps = successImagePreparationSteps({
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

  // 7. Existing image missing-local-file semantics remain known/pre-publication.
  {
    const missingInput = {
      ...baseInput,
      media: [{ ...imageMedia, relative_path: 'post-vk-test/missing.jpg' }]
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

  // 8. Video happy path: video.save -> multipart video_file -> one deterministic wall.post.
  {
    const steps = successVideoPreparationSteps({
      apiMethod: 'wall.post',
      check: (call) => {
        assert.equal(call.body.owner_id, '-12345');
        assert.equal(call.body.from_group, '1');
        assert.equal(call.body.message, 'Тест VK');
        assert.equal(call.body.attachments, 'video-12345_888');
        assert.equal(call.body.guid, 'post-vk-test:-12345');
      },
      response: { response: { post_id: 9002 } }
    });
    const calls = mockFetch(steps);
    const result = await vkPublisher.publish(videoInput());
    assert.equal(result.externalId, '9002');
    assert.equal(result.externalUrl, 'https://vk.com/wall-12345_9002');
    assert.equal(calls.length, 3);
    assert.equal(steps.length, 0);
  }

  // 9. Missing local video is rejected before even video.save, so zero external requests occur.
  {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run');
    };
    const missingVideo = { ...videoMedia, relative_path: 'post-vk-test/missing-video.mp4' };
    await expectPlatformError(vkPublisher.publish(videoInput({ media: [missingVideo] })), {
      retryable: false,
      outcomeUnknown: false,
      message: /локальное видео недоступно/
    });
    assert.equal(fetchCalls, 0);
  }

  // 10. video.save transport failure is preparation-only and safe to retry.
  {
    const steps = [{ apiMethod: 'video.save', error: new TypeError('video.save network down') }];
    mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(videoInput()), {
      retryable: true,
      outcomeUnknown: false,
      message: /video\.save.*подготовительная фаза/
    });
  }

  // 11. Video upload host 5xx is preparation-only and cannot create a wall post.
  {
    const steps = [
      {
        apiMethod: 'video.save',
        response: { response: { upload_url: 'https://upload.vk.test/video', owner_id: -12345, video_id: 888 } }
      },
      {
        apiMethod: null,
        url: 'https://upload.vk.test/video',
        status: 503,
        response: { error: 'temporary upload error' }
      }
    ];
    mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(videoInput()), {
      retryable: true,
      outcomeUnknown: false,
      message: /VK upload video.*подготовительная фаза/
    });
  }

  // 12. Inconsistent upload response is known/pre-publication and never reaches wall.post.
  {
    const steps = [
      {
        apiMethod: 'video.save',
        response: { response: { upload_url: 'https://upload.vk.test/video', owner_id: -12345, video_id: 888 } }
      },
      {
        apiMethod: null,
        url: 'https://upload.vk.test/video',
        response: { size: 21, video_id: 999 }
      }
    ];
    mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(videoInput()), {
      retryable: false,
      outcomeUnknown: false,
      message: /video_id 999 не совпадает/
    });
    assert.equal(steps.length, 0);
  }

  // 13. Canonical HEVC is rejected before network activity.
  {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run');
    };
    await assert.rejects(
      vkPublisher.publish(videoInput({ media: [{ ...videoMedia, video_codec: 'hevc' }] })),
      /canonical video должен быть H\.264/
    );
    assert.equal(fetchCalls, 0);
  }

  // 14. After successful video preparation, wall.post transport failure is the unknown-outcome boundary.
  {
    const steps = successVideoPreparationSteps({
      apiMethod: 'wall.post',
      error: new TypeError('connection dropped after video wall.post')
    });
    mockFetch(steps);
    await expectPlatformError(vkPublisher.publish(videoInput()), {
      retryable: false,
      outcomeUnknown: true,
      message: /VK wall\.post/
    });
    assert.equal(steps.length, 0);
  }

  // 15. PERSONAL image path omits group_id and posts to the positive user owner.
  {
    const personalInput = {
      ...baseInput,
      credentials: {
        accessToken: 'personal-vk-token',
        destinationKind: 'PERSONAL',
        userId: '54321',
        apiVersion: '5.199'
      }
    };
    const steps = [
      {
        apiMethod: 'photos.getWallUploadServer',
        check: (call) => assert.equal(call.body.group_id, undefined),
        response: { response: { upload_url: 'https://upload.vk.test/personal-photo' } }
      },
      {
        apiMethod: null,
        url: 'https://upload.vk.test/personal-photo',
        response: { server: 43, photo: '[2]', hash: 'hash-personal' }
      },
      {
        apiMethod: 'photos.saveWallPhoto',
        check: (call) => {
          assert.equal(call.body.group_id, undefined);
          assert.equal(call.body.user_id, '54321');
        },
        response: { response: [{ owner_id: 54321, id: 778 }] }
      },
      {
        apiMethod: 'wall.post',
        check: (call) => {
          assert.equal(call.body.owner_id, '54321');
          assert.equal(call.body.from_group, undefined);
          assert.equal(call.body.attachments, 'photo54321_778');
          assert.equal(call.body.guid, 'post-vk-test:54321');
        },
        response: { response: { post_id: 9003 } }
      }
    ];
    const calls = mockFetch(steps);
    const result = await vkPublisher.publish(personalInput);
    assert.equal(result.externalId, '9003');
    assert.equal(result.externalUrl, 'https://vk.com/wall54321_9003');
    assert.equal(calls.length, 4);
    assert.equal(steps.length, 0);
  }

  // 16. PERSONAL video path omits group_id in video.save and preserves positive wall owner.
  {
    const personalVideo = videoInput({
      credentials: {
        accessToken: 'personal-vk-token',
        destinationKind: 'PERSONAL',
        userId: '54321',
        apiVersion: '5.199'
      }
    });
    const steps = [
      {
        apiMethod: 'video.save',
        check: (call) => {
          assert.equal(call.body.group_id, undefined);
          assert.equal(call.body.wallpost, '0');
        },
        response: { response: { upload_url: 'https://upload.vk.test/personal-video', owner_id: 54321, video_id: 889 } }
      },
      {
        apiMethod: null,
        url: 'https://upload.vk.test/personal-video',
        response: { size: 21, video_id: 889 }
      },
      {
        apiMethod: 'wall.post',
        check: (call) => {
          assert.equal(call.body.owner_id, '54321');
          assert.equal(call.body.from_group, undefined);
          assert.equal(call.body.attachments, 'video54321_889');
          assert.equal(call.body.guid, 'post-vk-test:54321');
        },
        response: { response: { post_id: 9004 } }
      }
    ];
    const calls = mockFetch(steps);
    const result = await vkPublisher.publish(personalVideo);
    assert.equal(result.externalId, '9004');
    assert.equal(result.externalUrl, 'https://vk.com/wall54321_9004');
    assert.equal(calls.length, 3);
    assert.equal(steps.length, 0);
  }

  console.log(JSON.stringify({
    ok: true,
    scenarios: 16,
    legacyCommunityCredentials: true,
    personalImageDestination: true,
    personalVideoDestination: true,
    feedVideoAdapterImplemented: true,
    videoCapabilityStillLiveGated: true
  }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
