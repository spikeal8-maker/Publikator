import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-publication-intent-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: directory, PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
  APP_MASTER_KEY: 'publication-intent-test-key-longer-than-thirty-two-characters',
});
delete process.env.ADMIN_PASSWORD;

const { db, migrate } = await import('../dist/db.js');
const { requestAgentPublication } = await import('../dist/agent-publication-intent.js');
const { seedAgentPublicationDraft } = await import('./fixtures/agent-publication-intent-fixture.mjs');

try {
  migrate();
  const { identity, accountId, input } = seedAgentPublicationDraft(db);
  db.exec('DROP TABLE agent_publication_intents');
  db.pragma('user_version = 20');
  migrate();
  assert.equal(db.pragma('user_version', { simple: true }), 21);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_publication_intents').get().n, 0);
  let providerRequests = 0;
  const network = globalThis.fetch;
  globalThis.fetch = async () => { providerRequests++; throw new Error('Unexpected provider request'); };
  let intent;
  try {
    intent = requestAgentPublication(identity, input);
  } finally {
    globalThis.fetch = network;
  }
  assert.equal(providerRequests, 0);
  assert.equal(intent.status, 'WAITING_APPROVAL');
  assert.equal(intent.scheduleTimezone, 'Europe/Moscow');
  assert.equal(intent.scheduledAtUtc, input.when.scheduledAt);
  assert.deepEqual(intent.targetAccountIds, [accountId]);
  assert.equal(intent.preflight.ok, false);
  assert.equal(intent.preflight.issues.some((issue) => issue.code === 'ACCOUNT_FORMAT_NOT_CONFIRMED'), true);
  assert.deepEqual(requestAgentPublication(identity, input), intent);
  assert.throws(() => requestAgentPublication(identity, { ...input, when: { mode: 'NOW' } }),
    { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => requestAgentPublication(identity, { ...input, targetAccountIds: ['wrong-account'],
    idempotencyKey: 'wrong-recipients' }), { code: 'TARGETS_MISMATCH' });
  const post = db.prepare('SELECT status,schedule_mode,ready_revision_id,scheduled_at_utc FROM posts WHERE id=?').get(input.postId);
  assert.deepEqual(post, { status: 'DRAFT', schedule_mode: 'MANUAL', ready_revision_id: null, scheduled_at_utc: null });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_activity_events WHERE stage='WAITING_APPROVAL'").get().n, 1);
  assert.throws(() => db.prepare('UPDATE agent_publication_intents SET content_version=999 WHERE id=?').run(intent.intentId),
    /AGENT_PUBLICATION_INTENT_IMMUTABLE/);
  db.prepare("UPDATE agent_grants SET grant_version=grant_version+1 WHERE agent_id=?").run(identity.agentId);
  assert.throws(() => requestAgentPublication(identity, input), { code: 'RESOURCE_DENIED' });
  migrate();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_publication_intents').get().n, 1);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  console.log('Immutable agent publication intent, scope checks, scheduling and zero readiness mutations PASS');
} finally {
  if (db.open) db.close();
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
