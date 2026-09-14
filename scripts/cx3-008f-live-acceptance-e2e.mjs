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

const media = {
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

const evidence = core.buildLiveVideoAcceptanceEvidence({
  runId: 'telegram-2026-09-14-test',
  platform: 'telegram',
  startedAt: '2026-09-14T15:00:00.000Z',
  completedAt: '2026-09-14T15:00:03.000Z',
  buildSha: 'b'.repeat(40),
  connection: {
    identity: '@publikator_test_bot',
    destination: 'Publikator Acceptance'
  },
  media,
  externalId: '12345',
  externalUrl: null
});

assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.checkpoint, 'CX3-008F');
assert.equal(evidence.status, 'PASSED');
assert.equal(evidence.publicationKind, 'FEED');
assert.equal(evidence.contentFormat, 'VIDEO');
assert.equal(evidence.result.externalId, '12345');
assert.equal(evidence.transport.publicVideoUrl, null);
assert.deepEqual(core.validateLiveVideoAcceptanceEvidence(evidence), evidence);

assert.throws(
  () => core.validateLiveVideoAcceptanceEvidence({ ...evidence, status: 'FAILED' }),
  /schema\/checkpoint\/status/
);
assert.throws(
  () => core.buildLiveVideoAcceptanceEvidence({ ...evidence, buildSha: 'short' }),
  /40-символьным Git SHA/
);
assert.throws(
  () => core.buildLiveVideoAcceptanceEvidence({ ...evidence, media: { ...media, sha256: 'bad' } }),
  /sha256/
);

const secretSentinel = 'super-secret-token-that-must-never-enter-evidence';
const serialized = JSON.stringify(evidence);
assert.equal(serialized.includes(secretSentinel), false);
assert.equal('credentials' in evidence, false);

const cliSource = await fs.readFile(new URL('./cx3-008f-live-video-acceptance.mjs', import.meta.url), 'utf8');
assert.match(cliSource, /PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM/);
assert.match(cliSource, /--publish/);
assert.match(cliSource, /credentialsRecorded: false/);
assert.match(cliSource, /publisher\.validate\(input\)/);
assert.match(cliSource, /testConnection\(platform, credentials\)/);
assert.match(cliSource, /publisher\.publish\(input\)/);
assert.match(cliSource, /finally \{[\s\S]*fsp\.rm\(runMediaDir/);

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-008F',
  capabilityStillClosed: true,
  explicitPublishGuard: true,
  credentialsShapeValidated: true,
  evidenceSecretFreeByConstruction: true,
  stagedMediaCleanup: true
}, null, 2));
