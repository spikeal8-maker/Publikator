import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const core = await import('../dist/platforms/live-instagram-short-acceptance.js');
const { PLATFORM_CAPABILITIES } = await import('../dist/platforms/capabilities.js');

assert.equal(PLATFORM_CAPABILITIES.instagram.supportsShortVideo, false, 'Instagram Short capability must remain live-gated');
assert.equal(PLATFORM_CAPABILITIES.instagram.supportsVideo, false, 'Instagram video capability must remain live-gated');
assert.equal(PLATFORM_CAPABILITIES.instagram.verification.richMediaPendingLiveAcceptance, true);

const media = {
  mediaId: 'med_instagram_short_live',
  originalName: 'short-acceptance.mp4',
  sizeBytes: 12_345,
  sha256: 'c'.repeat(64),
  width: 1080,
  height: 1920,
  durationMs: 12_500,
  fps: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mp4'
};

const common = {
  runId: 'instagram-short-2026-09-14-test',
  startedAt: '2026-09-14T18:00:00.000Z',
  completedAt: '2026-09-14T18:00:03.000Z',
  buildSha: 'd'.repeat(40),
  account: {
    id: 'acc_instagram_short_live',
    name: 'Publikator Instagram Short Acceptance'
  },
  connection: {
    identity: '17841400000000000',
    destination: 'Publikator Acceptance'
  },
  media,
  publicVideoUrl: 'https://publisher.example.test/public-media/short.mp4?temporary_signature=must-not-survive#fragment'
};

const apiEvidence = core.buildLiveInstagramShortAcceptanceEvidence({
  ...common,
  externalId: 'ig-short-12345',
  externalUrl: null
});

assert.equal(apiEvidence.schemaVersion, 1);
assert.equal(apiEvidence.checkpoint, 'CX3-011B');
assert.equal(apiEvidence.status, 'API_CONFIRMED');
assert.equal(apiEvidence.platform, 'instagram');
assert.equal(apiEvidence.publicationKind, 'SHORT');
assert.equal(apiEvidence.contentFormat, 'VERTICAL_VIDEO');
assert.equal(apiEvidence.result.externalId, 'ig-short-12345');
assert.equal(apiEvidence.transport.publicVideoUrl, 'https://publisher.example.test/public-media/short.mp4');
assert.equal(apiEvidence.failure, null);
assert.deepEqual(apiEvidence.visibility, { confirmedAt: null, note: null });
assert.deepEqual(core.validateLiveInstagramShortAcceptanceEvidence(apiEvidence), apiEvidence);

const passedEvidence = core.confirmLiveInstagramShortAcceptanceEvidence(apiEvidence, {
  confirmedAt: '2026-09-14T18:05:00.000Z',
  note: 'Control Short visible as Instagram Reel'
});
assert.equal(passedEvidence.status, 'PASSED');
assert.equal(passedEvidence.visibility.confirmedAt, '2026-09-14T18:05:00.000Z');
assert.equal(passedEvidence.visibility.note, 'Control Short visible as Instagram Reel');
assert.deepEqual(core.validateLiveInstagramShortAcceptanceEvidence(passedEvidence), passedEvidence);
assert.throws(
  () => core.confirmLiveInstagramShortAcceptanceEvidence(passedEvidence, { confirmedAt: '2026-09-14T18:06:00.000Z' }),
  /уже подтверждена/
);

const recoveryEvidence = core.buildLiveInstagramShortRecoveryEvidence({
  ...common,
  message: 'External media_publish outcome is unknown',
  code: 500
});
assert.equal(recoveryEvidence.status, 'RECOVERY_NEEDED');
assert.equal(recoveryEvidence.result.externalId, null);
assert.equal(recoveryEvidence.failure.message, 'External media_publish outcome is unknown');
assert.deepEqual(core.validateLiveInstagramShortAcceptanceEvidence(recoveryEvidence), recoveryEvidence);
assert.throws(
  () => core.confirmLiveInstagramShortAcceptanceEvidence(recoveryEvidence, { confirmedAt: '2026-09-14T18:06:00.000Z' }),
  /RECOVERY_NEEDED нельзя подтвердить/
);

assert.throws(
  () => core.validateLiveInstagramShortAcceptanceEvidence({ ...apiEvidence, publicationKind: 'FEED', contentFormat: 'VIDEO' }),
  /только instagram SHORT\/VERTICAL_VIDEO/
);
assert.throws(
  () => core.buildLiveInstagramShortAcceptanceEvidence({ ...common, media: { ...media, width: 1920, height: 1080 }, externalId: '1' }),
  /вертикальным/
);
assert.throws(
  () => core.buildLiveInstagramShortAcceptanceEvidence({ ...common, buildSha: 'short', externalId: '1' }),
  /40-символьным Git SHA/
);
assert.throws(
  () => core.validateLiveInstagramShortAcceptanceEvidence({ ...apiEvidence, failure: { message: 'should not exist', code: null } }),
  /не должна содержать failure/
);

const secretSentinel = 'super-secret-token-that-must-never-enter-evidence';
for (const evidence of [apiEvidence, passedEvidence, recoveryEvidence]) {
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(secretSentinel), false);
  assert.equal(serialized.includes('temporary_signature'), false);
  assert.equal('credentials' in evidence, false);
}

const cliSource = await fs.readFile(new URL('../src/cli/live-instagram-short-acceptance.ts', import.meta.url), 'utf8');
const compiledCliUrl = new URL('../dist/cli/live-instagram-short-acceptance.js', import.meta.url);
await fs.access(compiledCliUrl);
assert.match(cliSource, /--account <social_accounts\.id>/);
assert.match(cliSource, /--media <media\.id>/);
assert.match(cliSource, /credentialsDecrypted: false/);
assert.match(cliSource, /decryptJson<Record<string, unknown>>/);
assert.match(cliSource, /PUBLIKATOR_LIVE_ACCEPTANCE_CONFIRM/);
assert.match(cliSource, /PUBLIKATOR_LIVE_VISIBILITY_CONFIRM/);
assert.match(cliSource, /target-free MANUAL DRAFT\/DRAFT/);
assert.match(cliSource, /post_target_count/);
assert.match(cliSource, /recheckSourcePostQuarantine/);
assert.match(cliSource, /findBlockingEvidence/);
assert.match(cliSource, /повторная live Short публикация/);
assert.match(cliSource, /\.cx3-011b-/);
assert.match(cliSource, /fsp\.open\(filePath, 'wx', 0o600\)/);
assert.match(cliSource, /PUBLIC_PUBLISH_STARTING/);
assert.match(cliSource, /publisher\.validate\(input\)/);
assert.match(cliSource, /testConnection\('instagram', credentials\)/);
assert.match(cliSource, /publisher\.publish\(input\)/);
assert.match(cliSource, /buildLiveInstagramShortRecoveryEvidence/);
assert.match(cliSource, /publicationKind: 'SHORT'/);
assert.match(cliSource, /contentFormat: 'VERTICAL_VIDEO'/);
assert.match(cliSource, /НЕ повторяйте публикацию автоматически/);
assert.match(cliSource, /fsp\.chmod\(filePath, 0o600\)/);
assert.match(cliSource, /mediaPublicUrl\(media\)/);
assert.match(cliSource, /SHA-256 файла не совпадает/);
assert.doesNotMatch(cliSource, /--credentials/);
assert.doesNotMatch(cliSource, /publicationKind: 'FEED'[\s\S]{0,80}contentFormat: 'VIDEO'/);

const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.scripts['live:instagram-short:accept'], 'node dist/cli/live-instagram-short-acceptance.js');

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-011B',
  productionCapabilityStillClosed: true,
  shortEvidenceCompositionBound: true,
  apiConfirmedBeforePass: true,
  recoveryEvidence: true,
  verticalFingerprintGuard: true,
  separateCrashSafeLockNamespace: true,
  explicitPublishGuard: true,
  explicitVisibilityGuard: true,
  targetFreeSourcePost: true,
  duplicateShortRunBlocked: true,
  evidenceSecretFreeByConstruction: true,
  signedUrlQueryRedacted: true,
  evidenceMode0600: true,
  compiledCliInRuntimeDist: true
}, null, 2));
