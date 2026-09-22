import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ADMIN_PASSWORD = 'vk-dest-001-ci-password';
const APP_MASTER_KEY = 'vk-dest-001-master-key-that-is-longer-than-thirty-two-characters';
const PHASE = process.env.VK_DEST_RESTART_PHASE || '';

async function restartPhase() {
  const stateFile = process.env.VK_DEST_STATE_FILE;
  assert.ok(stateFile, 'VK_DEST_STATE_FILE is required');
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.APP_MASTER_KEY = APP_MASTER_KEY;
  process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

  const { db, migrate, id, nowIso } = await import('../dist/db.js');
  const { encryptJson } = await import('../dist/crypto.js');
  const { setTargetSelection } = await import('../dist/publisher.js');
  migrate();

  try {
    if (PHASE === 'seed') {
      const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
      assert.ok(project?.id);
      const now = nowIso();
      const personalId = id('acc');
      const communityId = id('acc');
      db.prepare(`INSERT INTO social_accounts
        (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
        VALUES (?,?,?,?,1,?,?)`).run(
        personalId,
        'vk',
        'Restart Personal',
        encryptJson({ accessToken: 'restart-personal', destinationKind: 'PERSONAL', userId: '101', apiVersion: '5.199' }),
        now,
        now
      );
      db.prepare(`INSERT INTO social_accounts
        (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
        VALUES (?,?,?,?,1,?,?)`).run(
        communityId,
        'vk',
        'Restart Community',
        encryptJson({ accessToken: 'restart-community', destinationKind: 'COMMUNITY', groupId: '201', apiVersion: '5.199' }),
        now,
        now
      );
      const postId = id('post');
      db.prepare(`INSERT INTO posts
        (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        postId,
        project.id,
        'VK restart selection',
        'Persistent selected destinations',
        'DRAFT',
        'MANUAL',
        null,
        now,
        now
      );
      setTargetSelection(postId, [personalId, communityId]);
      await fs.writeFile(stateFile, JSON.stringify({ postId, selected: [personalId, communityId].sort() }), 'utf8');
    } else {
      const expected = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      const selected = db.prepare('SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1 ORDER BY account_id')
        .all(expected.postId).map((row) => row.account_id);
      assert.deepEqual(selected, expected.selected, 'selected targets must survive a real process restart');
    }
  } finally {
    db.close();
  }
}

if (PHASE) {
  await restartPhase();
  process.exit(0);
}

const restartDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-dest-restart-'));
const stateFile = path.join(restartDir, 'state.json');
const scriptPath = path.resolve(process.argv[1]);

function runRestartPhase(phase) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: restartDir,
      ADMIN_PASSWORD,
      APP_MASTER_KEY,
      PUBLIC_BASE_URL: 'https://publisher.example.test',
      VK_DEST_RESTART_PHASE: phase,
      VK_DEST_STATE_FILE: stateFile
    },
    encoding: 'utf8',
    timeout: 120000
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `VK destination restart ${phase} failed`);
}

try {
  runRestartPhase('seed');
  runRestartPhase('verify');
} finally {
  await fs.rm(restartDir, { recursive: true, force: true });
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-vk-dest-001-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.APP_MASTER_KEY = APP_MASTER_KEY;
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const sharp = (await import('sharp')).default;
const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { saveImage } = await import('../dist/media.js');
const {
  ensureTargets,
  publishPost,
  retryFailedTarget,
  setTargetSelection
} = await import('../dist/publisher.js');
const { snapshotContentRevision, markReadyRevision } = await import('../dist/content-versioning.js');
const { setPublisherForTests } = await import('../dist/platforms/index.js');
const { PlatformError } = await import('../dist/platforms/types.js');
const { resolveVkDestination } = await import('../dist/platforms/vk.js');
const { buildApp } = await import('../dist/app.js');

migrate();

const app = await buildApp();
await app.ready();
const login = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { password: ADMIN_PASSWORD }
});
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];

async function api(method, url, payload, expected = 200) {
  const response = await app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload })
  });
  assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
  return response.json();
}

function vkMethod(url) {
  return /\/method\/([^/?]+)/.exec(String(url))?.[1] || null;
}

function mockVkConnection(steps) {
  globalThis.fetch = async (request, init = {}) => {
    const method = vkMethod(request);
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body.entries()) : {};
    const step = steps.shift();
    assert.ok(step, `unexpected VK request ${method}`);
    assert.equal(method, step.method);
    if (step.check) step.check(body);
    return new Response(JSON.stringify(step.response), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}

const personalSteps = [
  {
    method: 'users.get',
    check: (body) => {
      assert.equal(body.user_ids, undefined);
      assert.equal(body.access_token, 'personal-token');
    },
    response: { response: [{ id: 101, first_name: 'Александр', last_name: 'Аликин', screen_name: 'alexander101' }] }
  },
  {
    method: 'photos.getWallUploadServer',
    check: (body) => assert.equal(body.group_id, undefined),
    response: { response: { upload_url: 'https://upload.vk.test/personal' } }
  }
];
mockVkConnection(personalSteps);
const personalTest = await api('POST', '/api/accounts/test', {
  platform: 'vk',
  credentials: { accessToken: 'personal-token', destinationKind: 'PERSONAL', apiVersion: '5.199' }
});
assert.equal(personalTest.details.destinationKind, 'PERSONAL');
assert.equal(personalTest.details.destinationId, '101');
assert.equal(personalTest.details.destinationName, 'Александр Аликин');
assert.match(personalTest.identity, /Личная страница/);
assert.equal(personalTest.destination, 'https://vk.com/alexander101');
assert.equal(personalSteps.length, 0);

const communitySteps = [
  {
    method: 'groups.getById',
    check: (body) => assert.equal(body.group_id, '201'),
    response: { response: { groups: [{ id: 201, name: 'ASA Lab', screen_name: 'asalab' }], profiles: [] } }
  },
  {
    method: 'photos.getWallUploadServer',
    check: (body) => assert.equal(body.group_id, '201'),
    response: { response: { upload_url: 'https://upload.vk.test/community' } }
  }
];
mockVkConnection(communitySteps);
const communityTest = await api('POST', '/api/accounts/test', {
  platform: 'vk',
  credentials: { accessToken: 'community-token', destinationKind: 'COMMUNITY', groupId: 'https://vk.com/club201', apiVersion: '5.199' }
});
assert.equal(communityTest.details.destinationKind, 'COMMUNITY');
assert.equal(communityTest.details.destinationId, '201');
assert.equal(communityTest.details.destinationName, 'ASA Lab');
assert.match(communityTest.identity, /Сообщество/);
assert.equal(communityTest.destination, 'https://vk.com/asalab');
assert.equal(communitySteps.length, 0);

function accountStorageCounts() {
  const accountCount = db.prepare('SELECT COUNT(*) AS count FROM social_accounts').get();
  const defaultTargetCount = db.prepare('SELECT COUNT(*) AS count FROM project_default_targets').get();
  return {
    accounts: Number(accountCount.count),
    defaultTargets: Number(defaultTargetCount.count)
  };
}

const invalidPersonalBefore = accountStorageCounts();
await api('POST', '/api/accounts', {
  platform: 'vk',
  name: 'Invalid Personal',
  credentials: {
    accessToken: 'personal-token',
    destinationKind: 'PERSONAL',
    apiVersion: '5.199'
  }
}, 400);
assert.deepEqual(
  accountStorageCounts(),
  invalidPersonalBefore,
  'invalid PERSONAL create must not persist account or project default target side effects'
);
assert.equal(
  Number(db.prepare('SELECT COUNT(*) AS count FROM social_accounts WHERE name=?').get('Invalid Personal').count),
  0
);

const invalidCommunityBefore = accountStorageCounts();
await api('POST', '/api/accounts', {
  platform: 'vk',
  name: 'Invalid Community',
  credentials: {
    accessToken: 'community-token',
    destinationKind: 'COMMUNITY',
    apiVersion: '5.199'
  }
}, 400);
assert.deepEqual(
  accountStorageCounts(),
  invalidCommunityBefore,
  'invalid COMMUNITY create must not persist account or project default target side effects'
);
assert.equal(
  Number(db.prepare('SELECT COUNT(*) AS count FROM social_accounts WHERE name=?').get('Invalid Community').count),
  0
);

const personalAccount = await api('POST', '/api/accounts', {
  platform: 'vk',
  name: 'Александр',
  credentials: {
    accessToken: 'personal-token',
    destinationKind: 'PERSONAL',
    userId: personalTest.details.destinationId,
    destinationName: personalTest.details.destinationName,
    apiVersion: '5.199'
  }
}, 201);

const personalBeforeInvalidPatch = db.prepare(
  'SELECT name,enabled,credentials_encrypted FROM social_accounts WHERE id=?'
).get(personalAccount.id);
assert.ok(personalBeforeInvalidPatch);
await api('PATCH', `/api/accounts/${personalAccount.id}`, {
  name: 'MUST NOT BE SAVED',
  enabled: false,
  credentials: {
    accessToken: 'personal-token',
    destinationKind: 'PERSONAL',
    apiVersion: '5.199'
  }
}, 400);
const personalAfterInvalidPatch = db.prepare(
  'SELECT name,enabled,credentials_encrypted FROM social_accounts WHERE id=?'
).get(personalAccount.id);
assert.deepEqual(
  personalAfterInvalidPatch,
  personalBeforeInvalidPatch,
  'invalid VK credential PATCH must be atomic'
);

const communityA = await api('POST', '/api/accounts', {
  platform: 'vk',
  name: 'ASA Lab',
  credentials: {
    accessToken: 'community-token',
    destinationKind: 'COMMUNITY',
    groupId: communityTest.details.destinationId,
    destinationName: communityTest.details.destinationName,
    apiVersion: '5.199'
  }
}, 201);

const legacyCommunity = await api('POST', '/api/accounts', {
  platform: 'vk',
  name: 'Школа 1580',
  credentials: {
    accessToken: 'legacy-community-token',
    groupId: '202',
    apiVersion: '5.199'
  }
}, 201);
const communityBId = legacyCommunity.id;

const now = nowIso();
const telegramId = id('acc');
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`).run(
  telegramId,
  'telegram',
  'ASA Lab',
  encryptJson({ botToken: 'telegram-token', chatId: '@asa_lab' }),
  now,
  now
);

const accountView = await api('GET', '/api/accounts');
const personalView = accountView.find((account) => account.id === personalAccount.id);
const communityAView = accountView.find((account) => account.id === communityA.id);
const communityBView = accountView.find((account) => account.id === communityBId);
assert.equal(personalView.destination_kind, 'PERSONAL');
assert.equal(personalView.destination_id, '101');
assert.equal(communityAView.destination_kind, 'COMMUNITY');
assert.equal(communityAView.destination_id, '201');
assert.equal(communityBView.destination_kind, 'COMMUNITY', 'legacy groupId must project as COMMUNITY');
assert.equal(communityBView.destination_id, '202');
assert.equal('credentials_encrypted' in personalView, false, 'account API must not expose encrypted credentials');

const sharedSocialUi = await fs.readFile(path.resolve('public/social-credentials.js'), 'utf8');
const routedSocialsUi = await fs.readFile(path.resolve('public/operator-pages-v4.js'), 'utf8');
assert.match(sharedSocialUi, /name="destinationKind" value="PERSONAL"/);
assert.match(sharedSocialUi, /name="destinationKind" value="COMMUNITY"/);
assert.match(sharedSocialUi, /Личная страница/);
assert.match(sharedSocialUi, /Сообщество \/ ID/);
assert.match(routedSocialsUi, /socialCredentialFields\(platform\)/);
assert.match(routedSocialsUi, /verifiedSocialCredentialsFromTest\(platform, form, checked\)/);

const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
assert.ok(project?.id);

const image = await sharp({
  create: {
    width: 32,
    height: 32,
    channels: 3,
    background: { r: 25, g: 50, b: 75 }
  }
}).jpeg().toBuffer();

const vkCalls = new Map();
const telegramCalls = new Map();
let failurePostId = null;
let failureOwnerId = null;
let failureRemaining = 0;

setPublisherForTests('vk', {
  platform: 'vk',
  validate(input) {
    resolveVkDestination(input.credentials);
    assert.ok(input.media.length >= 1);
  },
  async publish(input) {
    const destination = resolveVkDestination(input.credentials);
    const key = `${input.postId}:${destination.ownerId}`;
    vkCalls.set(key, (vkCalls.get(key) || 0) + 1);
    if (input.postId === failurePostId && destination.ownerId === failureOwnerId && failureRemaining > 0) {
      failureRemaining -= 1;
      throw new PlatformError('deterministic VK destination failure', { retryable: false, outcomeUnknown: false });
    }
    return {
      externalId: `vk-${destination.ownerId}-${vkCalls.get(key)}`,
      externalUrl: `https://vk.example.test/wall${destination.ownerId}`
    };
  }
});

setPublisherForTests('telegram', {
  platform: 'telegram',
  validate(input) {
    assert.ok(input.media.length >= 1);
  },
  async publish(input) {
    const key = input.postId;
    telegramCalls.set(key, (telegramCalls.get(key) || 0) + 1);
    return {
      externalId: `telegram-${telegramCalls.get(key)}`,
      externalUrl: 'https://telegram.example.test/post'
    };
  }
});

async function createReadyPost(title, accountIds) {
  const postId = id('post');
  const createdAt = nowIso();
  db.prepare(`INSERT INTO posts
    (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    postId,
    project.id,
    title,
    `${title} body`,
    'READY',
    'MANUAL',
    null,
    createdAt,
    createdAt
  );
  ensureTargets(postId);
  setTargetSelection(postId, accountIds);
  await saveImage(postId, `${postId}.jpg`, image);
  const revision = snapshotContentRevision(postId, 1, 'vk-dest-001');
  markReadyRevision(postId, 1, revision.id);

  const snapshotTargets = JSON.parse(revision.targets_json)
    .filter((target) => target.enabled)
    .map((target) => target.accountId)
    .sort();
  assert.deepEqual(snapshotTargets, [...new Set(accountIds)].sort(), 'READY revision must snapshot exact selected targets');
  return { postId, revisionId: revision.id };
}

function targetRows(postId) {
  return db.prepare(`SELECT pt.id,pt.account_id,pt.state,pt.attempts,a.platform,a.name
    FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.post_id=? AND pt.enabled=1 ORDER BY pt.account_id`).all(postId);
}

async function assertPublishedScenario(title, accountIds, expectedPlatforms) {
  const { postId } = await createReadyPost(title, accountIds);
  await publishPost(postId);
  const targets = targetRows(postId);
  assert.deepEqual(targets.map((target) => target.account_id).sort(), [...accountIds].sort());
  assert.ok(targets.every((target) => target.state === 'PUBLISHED'));
  assert.deepEqual(targets.map((target) => target.platform).sort(), [...expectedPlatforms].sort());
  return postId;
}

const oneCommunityPost = await assertPublishedScenario(
  'One VK community',
  [communityA.id],
  ['vk']
);
assert.equal(vkCalls.get(`${oneCommunityPost}:-201`), 1);

const twoCommunitiesPost = await assertPublishedScenario(
  'Two VK communities',
  [communityA.id, communityBId],
  ['vk', 'vk']
);
assert.equal(vkCalls.get(`${twoCommunitiesPost}:-201`), 1);
assert.equal(vkCalls.get(`${twoCommunitiesPost}:-202`), 1);

const personalCommunityPost = await assertPublishedScenario(
  'VK personal plus community',
  [personalAccount.id, communityA.id],
  ['vk', 'vk']
);
assert.equal(vkCalls.get(`${personalCommunityPost}:101`), 1);
assert.equal(vkCalls.get(`${personalCommunityPost}:-201`), 1);

const mixedPost = await assertPublishedScenario(
  'VK plus non-VK',
  [personalAccount.id, telegramId],
  ['telegram', 'vk']
);
assert.equal(vkCalls.get(`${mixedPost}:101`), 1);
assert.equal(telegramCalls.get(mixedPost), 1);

const failure = await createReadyPost(
  'VK failure isolation',
  [personalAccount.id, communityA.id, communityBId]
);
failurePostId = failure.postId;
failureOwnerId = '-201';
failureRemaining = 1;
await publishPost(failure.postId);

let failureTargets = targetRows(failure.postId);
const personalTarget = failureTargets.find((target) => target.account_id === personalAccount.id);
const failedTarget = failureTargets.find((target) => target.account_id === communityA.id);
const otherCommunityTarget = failureTargets.find((target) => target.account_id === communityBId);
assert.equal(personalTarget.state, 'PUBLISHED');
assert.equal(failedTarget.state, 'FAILED');
assert.equal(otherCommunityTarget.state, 'PUBLISHED');
assert.equal(vkCalls.get(`${failure.postId}:101`), 1);
assert.equal(vkCalls.get(`${failure.postId}:-201`), 1);
assert.equal(vkCalls.get(`${failure.postId}:-202`), 1);

await retryFailedTarget(failedTarget.id);
failureTargets = targetRows(failure.postId);
assert.ok(failureTargets.every((target) => target.state === 'PUBLISHED'));
assert.equal(vkCalls.get(`${failure.postId}:101`), 1, 'successful PERSONAL target must not be duplicated');
assert.equal(vkCalls.get(`${failure.postId}:-202`), 1, 'successful COMMUNITY target must not be duplicated');
assert.equal(vkCalls.get(`${failure.postId}:-201`), 2, 'failed target must retry independently');

const legacyDestination = resolveVkDestination({ accessToken: 'legacy', groupId: '-202', apiVersion: '5.199' });
assert.deepEqual(legacyDestination, { kind: 'COMMUNITY', id: '202', ownerId: '-202' });

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'VK-DEST-001',
  restartPersistence: true,
  oneVkCommunity: true,
  twoVkCommunities: true,
  personalPlusCommunity: true,
  vkPlusOtherPlatform: true,
  readyRevisionExactTargets: true,
  independentTargetStates: true,
  retryIsolationNoDuplicates: true,
  legacyGroupIdCompatibility: true,
  legacyGroupIdWriteApi: true,
  invalidPersonalCreateRejected: true,
  invalidCommunityCreateRejected: true,
  noCreateSideEffects: true,
  invalidPatchRejected: true,
  patchAtomicity: true,
  connectionDestinationIdentity: true,
  operatorDestinationControls: true
}, null, 2));

await app.close();
db.close();
await fs.rm(dataDir, { recursive: true, force: true });
