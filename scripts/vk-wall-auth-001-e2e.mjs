import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'vk-wall-auth-001-ci-password';
process.env.APP_MASTER_KEY = 'vk-wall-auth-001-master-key-value-longer-than-thirty-two-characters';

const { testConnection } = await import('../dist/platforms/connection-test.js');
const { resolveVkDestination } = await import('../dist/platforms/vk.js');

const originalFetch = globalThis.fetch;
const vkCalls = [];

function vkMethod(url) {
  const match = String(url).match(/\/method\/([^/?]+)/);
  return match ? match[1] : null;
}

function installVkMock(steps) {
  globalThis.fetch = async (input, init = {}) => {
    const method = vkMethod(input);
    assert.ok(method, `unexpected non-VK request: ${String(input)}`);
    const body = new URLSearchParams(String(init.body || ''));
    vkCalls.push({
      method,
      groupId: body.get('group_id'),
      accessTokenPresent: Boolean(body.get('access_token'))
    });
    const step = steps.shift();
    assert.ok(step, `unexpected VK request ${method}`);
    assert.equal(method, step.method);
    step.check?.(body);
    return new Response(JSON.stringify(step.response), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}

function groupAuthError27() {
  return {
    error: {
      error_code: 27,
      error_msg: 'Group authorization failed: method is unavailable with group auth.'
    }
  };
}

try {
  // USER token: users.get -> groups.getById -> photos.getWallUploadServer.
  vkCalls.length = 0;
  const userSteps = [
    {
      method: 'users.get',
      check: (body) => assert.equal(body.get('access_token'), 'user-token'),
      response: { response: [{ id: 10101, first_name: 'Test', last_name: 'Owner', screen_name: 'testowner' }] }
    },
    {
      method: 'groups.getById',
      check: (body) => {
        assert.equal(body.get('group_id'), '234903751');
        assert.equal(body.get('fields'), 'screen_name');
      },
      response: { response: { groups: [{ id: 234903751, name: 'IIBUSI', screen_name: 'iibusi' }], profiles: [] } }
    },
    {
      method: 'photos.getWallUploadServer',
      check: (body) => assert.equal(body.get('group_id'), '234903751'),
      response: { response: { upload_url: 'https://upload.vk.test/wall-photo' } }
    }
  ];
  installVkMock(userSteps);
  const checked = await testConnection('vk', {
    accessToken: 'user-token',
    apiVersion: '5.199',
    destinationKind: 'COMMUNITY',
    groupId: '-234903751'
  });

  assert.equal(checked.details?.authKind, 'USER');
  assert.equal(checked.details?.authenticatedUserId, '10101');
  assert.equal(checked.details?.authenticatedUserName, 'Test Owner');
  assert.equal(checked.details?.destinationKind, 'COMMUNITY');
  assert.equal(checked.details?.destinationId, '234903751');
  assert.equal(checked.details?.destinationName, 'IIBUSI');
  assert.equal(checked.details?.destinationScreenName, 'iibusi');
  assert.equal(checked.details?.wallPhotoReady, true);
  assert.equal(checked.details?.wallPostNotExecuted, true);
  assert.equal(checked.destination, 'https://vk.com/iibusi');
  assert.equal(userSteps.length, 0);
  assert.equal(vkCalls.filter((call) => call.method === 'wall.post').length, 0);

  const destination = resolveVkDestination({
    destinationKind: 'COMMUNITY',
    groupId: '-234903751'
  });
  assert.equal(destination.id, '234903751');
  assert.equal(destination.ownerId, '-234903751');

  // Community token rejected immediately by the first user-only capability.
  vkCalls.length = 0;
  const communityTokenSteps = [
    { method: 'users.get', response: groupAuthError27() }
  ];
  installVkMock(communityTokenSteps);
  await assert.rejects(
    () => testConnection('vk', {
      accessToken: 'community-token',
      apiVersion: '5.199',
      destinationKind: 'COMMUNITY',
      groupId: '-234903751'
    }),
    /Этот токен является токеном сообщества.*нужен User access token VK/
  );
  assert.equal(communityTokenSteps.length, 0);
  assert.equal(vkCalls.filter((call) => call.method === 'wall.post').length, 0);

  // Error 27 from wall upload readiness is classified the same way.
  vkCalls.length = 0;
  const wallPhoto27Steps = [
    {
      method: 'users.get',
      response: { response: [{ id: 10101, first_name: 'Test', last_name: 'Owner' }] }
    },
    {
      method: 'groups.getById',
      response: { response: { groups: [{ id: 234903751, name: 'IIBUSI', screen_name: 'iibusi' }], profiles: [] } }
    },
    {
      method: 'photos.getWallUploadServer',
      response: groupAuthError27()
    }
  ];
  installVkMock(wallPhoto27Steps);
  await assert.rejects(
    () => testConnection('vk', {
      accessToken: 'ambiguous-token',
      apiVersion: '5.199',
      destinationKind: 'COMMUNITY',
      groupId: '234903751'
    }),
    /Этот токен является токеном сообщества.*нужен User access token VK/
  );
  assert.equal(wallPhoto27Steps.length, 0);
  assert.equal(vkCalls.filter((call) => call.method === 'wall.post').length, 0);

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'VK-WALL-AUTH-001',
    userTokenConnection: true,
    communityTokenRejected: true,
    error27Classified: true,
    groupIdNormalized: true,
    wallPhotoCapability: true,
    wallPostCallsDuringConnectionTest: 0
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
