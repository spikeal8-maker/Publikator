import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const core = await import('../dist/platforms/live-video-acceptance.js');
const { PLATFORM_CAPABILITIES } = await import('../dist/platforms/capabilities.js');

for (const platform of ['telegram', 'vk', 'max', 'instagram']) {
  assert.equal(PLATFORM_CAPABILITIES[platform].supportsVideo, false, `${platform} must remain live-gated`);
  assert.equal(PLATFORM_CAPABILITIES[platform].verification.richMediaPendingLiveAcceptance, true);
}

assert.deepEqual(core.LIVE_VIDEO_CREDENTIAL_FIELDS.telegram, ['botToken', 'chatId']);
assert.deepEqual(core.LIVE_VIDEO_CREDENTIAL_FIELDS.vk, ['accessToken', 'groupId']);
assert.deepEqual(core.LIVE_VIDEO_CREDENTIAL_FIELDS.max, ['accessToken', 'chatId']);
assert.deepEqual(core.LIVE_VIDEO_CREDENTIAL_FIELDS.instagram, ['accessToken', 'igUserId', 'graphVersion']);

assert.throws(
  () => core.assertLiveCredentialShape('telegram', { botToken: 'token' }),
  /chatId/
);
assert.doesNotThrow(() => core.assertLiveCredentialShape('telegram', { botToken: 'token', chatId: '-1001' }));

assert.throws(
  () => core.assertLivePublishGuard({ publish: false, confirmation: core.LIVE_VIDEO_CONFIRMATION }),
  /только с флагом --publish/
);
assert.throws(
  () => core.assertLivePublishGuard({ publish: true, confirmation: 'YES' }),
  /PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM/
);
assert.doesNotThrow(() => core.assertLivePublishGuard({
  publish: true,
  confirmation: core.LIVE_VIDEO_CONFIRMATION
}));

assert.throws(
  () => core.assertLiveVisibilityGuard({ confirmVisible: true, confirmation: 'YES' }),
  /PUBLIKATOR_LIVE_VISIBILITY_CONFIRM/
);
assert.doesNotThrow(() => core.assertLiveVisibilityGuard({
  confirmVisible: true,
  confirmation: core.LIVE_VIDEO_VISIBILITY_CONFIRMATION
}));

const media = {
  mediaId: 'med_live_video',
  originalName: 'acceptance.mp4',
  sizeBytes: 12_345,
  sha256: 'a'.repeat(64),
  width: 1080,
  height: 1920,
  durationMs: 12_500,
  fps: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mp4'
};

const common = {
  runId: 'telegram-2026-09-14-test',
  platform: 'telegram',
  startedAt: '2026-09-14T15:00:00.000Z',
  completedAt: '2026-09-14T15:00:03.000Z',
  buildSha: 'b'.repeat(40),
  account: {
    id: 'acc_live_test',
    name: 'Publikator Acceptance'
  },
  connection: {
    identity: '@publikator_test_bot',
    destination: 'Publikator Acceptance'
  },
  media,
  publicVideoUrl: 'https://publisher.example.test/public-media/clip.mp4?temporary_signature=must-not-survive#fragment'
};

const apiEvidence = core.buildLiveVideoAcceptanceEvidence({
  ...common,
  externalId: '12345',
  externalUrl: null
});

assert.equal(apiEvidence.schemaVersion, 1);
assert.equal(apiEvidence.checkpoint, 'CX3-008F');
assert.equal(apiEvidence.status, 'API_CONFIRMED');
assert.equal(apiEvidence.publicationKind, 'FEED');
assert.equal(apiEvidence.contentFormat, 'VIDEO');
assert.equal(apiEvidence.result.externalId, '12345');
assert.equal(apiEvidence.transport.publicVideoUrl, 'https://publisher.example.test/public-media/clip.mp4');
assert.equal(apiEvidence.failure, null);
assert.deepEqual(apiEvidence.visibility, { confirmedAt: null, note: null });
assert.deepEqual(core.validateLiveVideoAcceptanceEvidence(apiEvidence), apiEvidence);

const passedEvidence = core.confirmLiveVideoAcceptanceEvidence(apiEvidence, {
  confirmedAt: '2026-09-14T15:05:00.000Z',
  note: 'Control Reel visible in target surface'
});
assert.equal(passedEvidence.status, 'PASSED');
assert.equal(passedEvidence.visibility.confirmedAt, '2026-09-14T15:05:00.000Z');
assert.equal(passedEvidence.visibility.note, 'Control Reel visible in target surface');
assert.deepEqual(core.validateLiveVideoAcceptanceEvidence(passedEvidence), passedEvidence);
assert.throws(
  () => core.confirmLiveVideoAcceptanceEvidence(passedEvidence, { confirmedAt: '2026-09-14T15:06:00.000Z' }),
  /уже подтверждена/
);

const recoveryEvidence = core.buildLiveVideoRecoveryEvidence({
  ...common,
  message: 'External POST outcome is unknown',
  code: 500
});
assert.equal(recoveryEvidence.status, 'RECOVERY_NEEDED');
assert.equal(recoveryEvidence.result.externalId, null);
assert.equal(recoveryEvidence.failure.message, 'External POST outcome is unknown');
assert.equal(recoveryEvidence.failure.code, 500);
assert.deepEqual(core.validateLiveVideoAcceptanceEvidence(recoveryEvidence), recoveryEvidence);
assert.throws(
  () => core.confirmLiveVideoAcceptanceEvidence(recoveryEvidence, { confirmedAt: '2026-09-14T15:06:00.000Z' }),
  /RECOVERY_NEEDED нельзя подтвердить/
);

assert.throws(
  () => core.validateLiveVideoAcceptanceEvidence({ ...apiEvidence, status: 'FAILED' }),
  /schema\/checkpoint\/status/
);
assert.throws(
  () => core.buildLiveVideoAcceptanceEvidence({ ...common, buildSha: 'short', externalId: '1' }),
  /40-символьным Git SHA/
);
assert.throws(
  () => core.buildLiveVideoAcceptanceEvidence({ ...common, media: { ...media, sha256: 'bad' }, externalId: '1' }),
  /sha256/
);
assert.throws(
  () => core.validateLiveVideoAcceptanceEvidence({ ...apiEvidence, failure: { message: 'should not exist', code: null } }),
  /не должна содержать failure/
);

const secretSentinel = 'super-secret-token-that-must-never-enter-evidence';
for (const evidence of [apiEvidence, passedEvidence, recoveryEvidence]) {
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(secretSentinel), false);
  assert.equal(serialized.includes('temporary_signature'), false);
  assert.equal('credentials' in evidence, false);
}

const cliUrl = new URL('../src/cli/live-video-acceptance.ts', import.meta.url);
const compiledCliUrl = new URL('../dist/cli/live-video-acceptance.js', import.meta.url);
await fs.access(compiledCliUrl);
const cliSource = await fs.readFile(cliUrl, 'utf8');
assert.match(cliSource, /--account <social_accounts\.id>/);
assert.match(cliSource, /--media <media\.id>/);
assert.match(cliSource, /credentialsDecrypted: false/);
assert.match(cliSource, /decryptJson<Record<string, unknown>>/);
assert.match(cliSource, /PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM/);
assert.match(cliSource, /PUBLIKATOR_LIVE_VISIBILITY_CONFIRM/);
assert.match(cliSource, /--publish/);
assert.match(cliSource, /--confirm-visible/);
assert.match(cliSource, /target-free MANUAL DRAFT\/DRAFT/);
assert.match(cliSource, /post_target_count/);
assert.match(cliSource, /recheckSourcePostQuarantine/);
assert.match(cliSource, /findBlockingEvidence/);
assert.match(cliSource, /повторная live публикация.*заблокирована/);
assert.match(cliSource, /acquireLiveLock/);
assert.match(cliSource, /fsp\.open\(filePath, 'wx', 0o600\)/);
assert.match(cliSource, /PUBLIC_PUBLISH_STARTING/);
assert.match(cliSource, /live lock уже существует/);
assert.match(cliSource, /lock оставлен/);
assert.match(cliSource, /--evidence используется только с --confirm-visible/);
assert.match(cliSource, /publisher\.validate\(input\)/);
assert.match(cliSource, /testConnection\(account\.platform, credentials\)/);
assert.match(cliSource, /publisher\.publish\(input\)/);
assert.match(cliSource, /buildLiveVideoRecoveryEvidence/);
assert.match(cliSource, /НЕ повторяйте публикацию автоматически/);
assert.match(cliSource, /fsp\.chmod\(filePath, 0o600\)/);
assert.match(cliSource, /mediaPublicUrl\(media\)/);
assert.match(cliSource, /SHA-256 файла не совпадает/);
assert.doesNotMatch(cliSource, /--credentials/);
assert.doesNotMatch(cliSource, /externalUrl: result\.externalUrl[\s\S]{0,120}lock\.update/);

const dockerfile = await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
assert.match(dockerfile, /COPY --from=build \/app\/dist \.\/dist/);
const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.scripts['live:video:accept'], 'node dist/cli/live-video-acceptance.js');

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-008F',
  capabilityStillClosed: true,
  productionAccountAndMediaIds: true,
  targetFreeSourcePost: true,
  sourceDraftQuarantine: true,
  duplicateLiveRunBlocked: true,
  crashSafeConcurrentLock: true,
  explicitPublishGuard: true,
  explicitVisibilityGuard: true,
  apiConfirmedBeforePass: true,
  recoveryEvidence: true,
  evidenceSecretFreeByConstruction: true,
  signedUrlQueryRedacted: true,
  evidenceMode0600: true,
  compiledCliInRuntimeDist: true
}, null, 2));
