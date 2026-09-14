import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const script of ['scripts/telegram-feed-adapter-e2e.mjs', 'scripts/telegram-story-adapter-e2e.mjs']) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 120000
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `${script} failed`);
}

console.log(JSON.stringify({
  ok: true,
  telegramFeedAndStoryRegressions: true,
  isolatedProcesses: true
}, null, 2));
