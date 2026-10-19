import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Separate process captures the actual Fastify/Pino stdout and stderr streams.
// The fixture uses invented credentials, never keys supplied by an operator.
const fixtureSecrets = [
  '123456:FAKE-OBSERVABILITY-TEST-TOKEN',
  'FAKE-MAX-OBSERVABILITY-SECRET',
  '765432:FAKE-SAVED-TELEGRAM-CREDENTIAL',
  'vk1.a.FAKE_SAVED_VK_KEY_NO_REAL_CREDENTIAL'
];
const run = spawnSync(process.execPath, ['scripts/social-connection-observability-e2e.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env },
  encoding: 'utf8',
  timeout: 180000,
  maxBuffer: 16 * 1024 * 1024
});
const log = String(run.stdout || '') + String(run.stderr || '');
for (const secret of fixtureSecrets) {
  assert.equal(log.includes(secret), false,
    'A mock secret escaped into Pino/stdout/stderr; see focused diagnostic failure');
  assert.equal(log.includes(encodeURIComponent(secret)), false,
    'An encoded mock secret escaped into the process output');
}
assert.equal(run.status, 0, 'Social connection integration process failed without echoing secrets');
assert.match(log, /"checkpoint":"SOCIAL-ERROR-VISIBILITY-001"/);
console.log(JSON.stringify({
  ok: true,
  checkpoint: 'SOCIAL-ERROR-VISIBILITY-PROCESS-LOG',
  childStatus: run.status,
  stdoutAndStderrSecretFree: true,
  checkedFakeSecrets: fixtureSecrets.length,
  focus: 'ordinary and saved account checks, structured errors, OAuth logs, browser/mobile/clipboard'
}));
