import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'cred-01b-test-password';
process.env.APP_MASTER_KEY = 'cred-01b-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { inspectSocialCredential } = await import('../dist/platforms/credential-inspection.js');
const { buildCapabilityProfile } = await import('../dist/social-credential-capability.js');
const { PLATFORM_CAPABILITIES } = await import('../dist/platforms/capabilities.js');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function mockFetch(steps) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body.entries()) : null;
    calls.push({ url: url.toString(), host: url.host, path: url.pathname, method, body });

    const step = steps.shift();
    assert.ok(step, `Unexpected fetch ${method} ${url}`);
    if (step.host) assert.equal(url.host, step.host);
    if (step.path) assert.equal(url.pathname, step.path);
    if (step.method) assert.equal(method, step.method);
    if (step.check) step.check({ url, method, body });
    if (step.error) throw step.error;
    return json(step.response ?? {}, step.status ?? 200);
  };
  return calls;
}

function adapterMap(platform) {
  const cap = PLATFORM_CAPABILITIES[platform];
  return {
    TEXT: cap.supportsTextOnly,
    IMAGE: cap.supportsImage,
    CAROUSEL: cap.supportsCarousel,
    VIDEO: cap.supportsVideo,
    SHORT: cap.supportsShortVideo,
    STORY: cap.supportsStories
  };
}

function assertNoPublicWrites(calls) {
  for (const call of calls) {
    assert.equal(call.path.includes('/sendMessage'), false);
    assert.equal(call.path.includes('/sendPhoto'), false);
    assert.equal(call.path.includes('/sendMediaGroup'), false);
    assert.equal(call.path.includes('/media_publish'), false);
    assert.equal(call.path.includes('/messages'), false);
    assert.equal(call.path.includes('/method/wall.post'), false);
  }
}

// 1. Telegram full feed evidence + granular rights.
{
  const steps = [
    { path: '/bot123456:telegram-test-token/getMe', response: { ok: true, result: { id: 42, username: 'school_bot' } } },
    { path: '/bot123456:telegram-test-token/getChat', response: { ok: true, result: { id: -1001, type: 'channel', title: 'School' } } },
    {
      path: '/bot123456:telegram-test-token/getChatMember',
      response: {
        ok: true,
        result: {
          status: 'administrator',
          can_post_messages: true,
          can_edit_messages: true,
          can_delete_messages: false,
          can_post_stories: true
        }
      }
    }
  ];
  const calls = mockFetch(steps);
  const result = await inspectSocialCredential('telegram', {
    botToken: '123456:telegram-test-token',
    chatId: '-1001'
  });
  assert.equal(result.credential.validity, 'CONFIRMED');
  assert.equal(result.credential.providerType, 'BOT');
  assert.equal(result.destination?.resolutionState, 'CONFIRMED');
  assert.equal(result.publicationEvidence.IMAGE?.state, 'CONFIRMED');
  assert.equal(result.publicationEvidence.CAROUSEL?.state, 'CONFIRMED');
  assert.equal(result.methods.find((item) => item.method === 'telegram.can_delete_messages')?.state, 'DENIED');
  assert.equal(result.methods.find((item) => item.method === 'telegram.can_post_stories')?.state, 'CONFIRMED');
  assert.equal(steps.length, 0);
  assertNoPublicWrites(calls);
}

// 2. Telegram valid token + missing publish rights stays CONFIRMED and becomes SETUP_REQUIRED.
{
  const steps = [
    { path: '/bot123456:telegram-test-token/getMe', response: { ok: true, result: { id: 42, username: 'school_bot' } } },
    { path: '/bot123456:telegram-test-token/getChat', response: { ok: true, result: { id: -1001, type: 'channel', title: 'School' } } },
    {
      path: '/bot123456:telegram-test-token/getChatMember',
      response: { ok: true, result: { status: 'administrator', can_post_messages: false } }
    }
  ];
  mockFetch(steps);
  const result = await inspectSocialCredential('telegram', {
    botToken: '123456:telegram-test-token',
    chatId: '-1001'
  });
  assert.equal(result.credential.validity, 'CONFIRMED');
  assert.equal(result.publicationEvidence.IMAGE?.state, 'SETUP_REQUIRED');
  assert.ok(result.remediation.some((item) => item.code === 'TELEGRAM_CAN_POST_MESSAGES_REQUIRED'));
}

// 3. Telegram later timeout preserves confirmed token + destination and marks only later readiness unavailable.
{
  const secret = '123456:telegram-secret-path-token';
  const steps = [
    { path: `/bot${secret}/getMe`, response: { ok: true, result: { id: 42, username: 'school_bot' } } },
    { path: `/bot${secret}/getChat`, response: { ok: true, result: { id: -1001, type: 'channel', title: 'School' } } },
    {
      path: `/bot${secret}/getChatMember`,
      error: new TypeError(`request failed https://api.telegram.org/bot${secret}/getChatMember`)
    }
  ];
  mockFetch(steps);
  const result = await inspectSocialCredential('telegram', { botToken: secret, chatId: '-1001' });
  assert.equal(result.credential.validity, 'CONFIRMED');
  assert.equal(result.destination?.resolutionState, 'CONFIRMED');
  assert.equal(result.publicationEvidence.IMAGE?.state, 'UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes(secret), false);
}

// 4. Telegram explicit invalid token.
{
  const steps = [
    {
      path: '/bot123456:telegram-bad-token/getMe',
      status: 401,
      response: { ok: false, error_code: 401, description: 'Unauthorized with arbitrary prose' }
    }
  ];
  mockFetch(steps);
  const result = await inspectSocialCredential('telegram', {
    botToken: '123456:telegram-bad-token',
    chatId: '-1001'
  });
  assert.equal(result.credential.validity, 'INVALID');
}

// 5. MAX valid token + missing write stays valid and reports setup requirement.
{
  const steps = [
    { host: 'platform-api2.max.ru', path: '/me', response: { user_id: 99, username: 'max_bot' } },
    {
      host: 'platform-api2.max.ru',
      path: '/chats/-100500/members/me',
      response: { is_owner: false, is_admin: true, permissions: ['read_all_messages', 'edit'] }
    }
  ];
  const calls = mockFetch(steps);
  const result = await inspectSocialCredential('max', {
    accessToken: 'max-valid-token',
    chatId: '-100500'
  });
  assert.equal(result.credential.validity, 'CONFIRMED');
  assert.equal(result.publicationEvidence.IMAGE?.state, 'SETUP_REQUIRED');
  assert.ok(result.remediation.some((item) => item.code === 'MAX_WRITE_REQUIRED'));
  assertNoPublicWrites(calls);
}

// 6. VK GROUP classification uses groups.getTokenPermissions and never probes public write.
{
  const steps = [
    {
      host: 'api.vk.com',
      path: '/method/groups.getTokenPermissions',
      method: 'POST',
      response: { response: { permissions: [{ name: 'wall' }, { name: 'photos' }] } }
    },
    {
      host: 'api.vk.com',
      path: '/method/groups.getById',
      method: 'POST',
      response: { response: [{ id: 777, name: 'School', screen_name: 'school' }] }
    }
  ];
  const calls = mockFetch(steps);
  const result = await inspectSocialCredential('vk', {
    accessToken: 'vk-group-token',
    groupId: '777',
    destinationKind: 'COMMUNITY',
    apiVersion: '5.199'
  });
  assert.equal(result.credential.validity, 'CONFIRMED');
  assert.equal(result.credential.providerType, 'GROUP');
  assert.deepEqual(result.credential.declaredPermissions, ['photos', 'wall']);
  assert.equal(result.publicationEvidence.IMAGE?.state, 'SETUP_REQUIRED');
  assert.ok(result.methods.some((item) => item.method === 'photos.getWallUploadServer'
    && item.state === 'NOT_SUPPORTED_FOR_CREDENTIAL_TYPE'));
  assertNoPublicWrites(calls);
}

// 7. VK USER classification requires account.getAppPermissions; users.get provides identity only.
{
  const steps = [
    {
      host: 'api.vk.com',
      path: '/method/groups.getTokenPermissions',
      response: { error: { error_code: 27, error_msg: 'arbitrary text that must not drive classification' } }
    },
    {
      host: 'api.vk.com',
      path: '/method/account.getAppPermissions',
      response: { response: 8196 }
    },
    {
      host: 'api.vk.com',
      path: '/method/users.get',
      response: { response: [{ id: 123, first_name: 'Alex', last_name: 'User', screen_name: 'id123' }] }
    },
    {
      host: 'api.vk.com',
      path: '/method/groups.getById',
      response: { response: [{ id: 777, name: 'School', screen_name: 'school' }] }
    },
    {
      host: 'api.vk.com',
      path: '/method/photos.getWallUploadServer',
      response: { response: { upload_url: 'https://upload.example.test/' } }
    }
  ];
  const calls = mockFetch(steps);
  const result = await inspectSocialCredential('vk', {
    accessToken: 'vk-user-token',
    groupId: '777',
    destinationKind: 'COMMUNITY',
    apiVersion: '5.199'
  });
  assert.equal(result.credential.providerType, 'USER');
  assert.equal(result.credential.validity, 'CONFIRMED');
  assert.equal(result.credential.permissionsSource, 'account.getAppPermissions');
  assert.equal(result.publicationEvidence.IMAGE?.state, 'CONFIRMED');
  assert.ok(result.methods.some((item) => item.method === 'wall.post' && item.state === 'NOT_CHECKED'));
  assertNoPublicWrites(calls);
}

// 8. USER credential without explicit destination must not silently become PERSONAL.
{
  const steps = [
    {
      path: '/method/groups.getTokenPermissions',
      response: { error: { error_code: 27, error_msg: 'not group' } }
    },
    {
      path: '/method/account.getAppPermissions',
      response: { response: 8196 }
    },
    {
      path: '/method/users.get',
      response: { response: [{ id: 123, first_name: 'Alex', last_name: 'User' }] }
    }
  ];
  mockFetch(steps);
  const result = await inspectSocialCredential('vk', {
    accessToken: 'vk-user-token-without-destination',
    apiVersion: '5.199'
  });
  assert.equal(result.credential.providerType, 'USER');
  assert.equal(result.destination?.resolutionState, 'UNKNOWN');
  assert.equal(result.publicationEvidence.IMAGE?.state, 'UNKNOWN');
  assert.equal(result.methods.some((item) => item.method === 'photos.getWallUploadServer'
    && item.state === 'NOT_CHECKED'), true);
}

// 9. users.get success alone cannot classify USER; SERVICE/UNKNOWN remains conservative.
{
  const steps = [
    {
      path: '/method/groups.getTokenPermissions',
      response: { error: { error_code: 27, error_msg: 'not group' } }
    },
    {
      path: '/method/account.getAppPermissions',
      response: { error: { error_code: 15, error_msg: 'method denied for this auth type' } }
    },
    {
      path: '/method/users.get',
      response: { response: [{ id: 123, first_name: 'Readable', last_name: 'Identity' }] }
    }
  ];
  mockFetch(steps);
  const result = await inspectSocialCredential('vk', {
    accessToken: 'vk-service-like-token',
    userId: '123',
    destinationKind: 'PERSONAL',
    apiVersion: '5.199'
  });
  assert.equal(result.credential.validity, 'CONFIRMED');
  assert.equal(result.credential.providerType, 'SERVICE_OR_UNKNOWN');
  assert.notEqual(result.credential.providerType, 'USER');
  assert.equal(result.publicationEvidence.IMAGE?.state, 'UNKNOWN');
}

// 10. VK provider outage is UNAVAILABLE, not INVALID, and no human prose decides type.
{
  const steps = [
    { path: '/method/groups.getTokenPermissions', error: new TypeError('network unavailable one') },
    { path: '/method/account.getAppPermissions', error: new TypeError('network unavailable two') },
    { path: '/method/users.get', error: new TypeError('network unavailable three') }
  ];
  mockFetch(steps);
  const result = await inspectSocialCredential('vk', {
    accessToken: 'vk-outage-token',
    userId: '123',
    destinationKind: 'PERSONAL',
    apiVersion: '5.199'
  });
  assert.equal(result.credential.validity, 'UNAVAILABLE');
  assert.equal(result.credential.providerType, 'UNKNOWN');
}

// 11. Instagram identity is confirmed, but identity-only evidence cannot become READY/FULL.
{
  const steps = [
    {
      host: 'graph.facebook.com',
      path: '/v24.0/17841400000000000',
      response: { id: '17841400000000000', username: 'school_ig', account_type: 'BUSINESS' }
    }
  ];
  const calls = mockFetch(steps);
  const inspection = await inspectSocialCredential('instagram', {
    accessToken: 'ig-valid-token',
    igUserId: '17841400000000000',
    graphVersion: 'v24.0'
  });
  assert.equal(inspection.credential.validity, 'CONFIRMED');
  assert.equal(inspection.publicationEvidence.IMAGE?.state, 'UNKNOWN');
  assert.equal(inspection.runtimePrerequisiteEvidence.find((item) => item.format === 'IMAGE')?.state, 'CONFIRMED');
  const profile = buildCapabilityProfile({
    inspectionCompleted: true,
    providerType: inspection.credential.providerType,
    credential: inspection.credential,
    destination: inspection.destination,
    methods: inspection.methods,
    publicationEvidence: inspection.publicationEvidence,
    runtimePrerequisites: inspection.runtimePrerequisiteEvidence,
    remediation: inspection.remediation,
    warnings: inspection.warnings,
    adapterCapability: adapterMap('instagram')
  });
  assert.notEqual(profile.accessLevel, 'FULL');
  assert.notEqual(profile.semantic.publicationReadiness.IMAGE.state, 'READY');
  assertNoPublicWrites(calls);
}

// 12. No inspector result may contain historical implementation prose.
{
  const steps = [
    { path: '/bot123456:telegram-test-token/getMe', response: { ok: true, result: { id: 42 } } },
    { path: '/bot123456:telegram-test-token/getChat', response: { ok: true, result: { id: -1001, type: 'channel' } } },
    { path: '/bot123456:telegram-test-token/getChatMember', response: { ok: true, result: { status: 'administrator', can_post_messages: true } } }
  ];
  mockFetch(steps);
  const result = await inspectSocialCredential('telegram', {
    botToken: '123456:telegram-test-token',
    chatId: '-1001'
  });
  const serialized = JSON.stringify(result).toLowerCase();
  assert.equal(serialized.includes('n8n'), false);
  assert.equal(serialized.includes('key-02'), false);
  assert.equal(serialized.includes('pull request'), false);
}

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CRED-01B',
  scenarios: 12,
  telegramLayeredEvidence: true,
  maxLimitedCredentialPreserved: true,
  vkTypeSpecificEvidence: true,
  vkUsersGetNotUserProof: true,
  instagramIdentityNotPublishProof: true,
  noPublicWriteCalls: true,
  secretErrorsRedacted: true,
  noInternalCheckpointProse: true
}, null, 2));
