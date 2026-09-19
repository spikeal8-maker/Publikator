import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-007-api-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cx3-007-api-password';
process.env.APP_MASTER_KEY = 'cx3-007-api-master-key-value-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');

migrate();
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const createdAt = nowIso();
db.prepare(`INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`).run('acc_dashboard_tg', 'telegram', 'Dashboard TG', encryptJson({ token: 'mock' }), createdAt, createdAt);
db.prepare(`INSERT INTO project_default_targets (project_id,account_id,created_at) VALUES (?,?,?)`)
  .run(projectId,'acc_dashboard_tg',createdAt);
const app = await buildApp();
await app.ready();

const query = 'todayFrom=2026-09-14T00:00:00.000Z&todayTo=2026-09-15T00:00:00.000Z&weekTo=2026-09-21T00:00:00.000Z';
const anonymous = await app.inject({ method: 'GET', url: `/api/editorial-dashboard?${query}` });
assert.equal(anonymous.statusCode, 401, `anonymous dashboard must be protected: ${anonymous.body}`);
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];
const request = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });

async function createPost(title, scheduleMode = 'MANUAL', scheduledAt = null) {
  const payload = { projectId, title, body: `${title} body`, scheduleMode };
  if (scheduledAt) payload.scheduledAt = scheduledAt;
  const response = await request('POST', '/api/posts', payload);
  assert.equal(response.statusCode, 201, `create ${title}: ${response.body}`);
  return response.json();
}
function targetFor(postId) {
  const target = db.prepare(`SELECT pt.id FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.post_id=? AND a.platform='telegram'`).get(postId);
  assert.ok(target, `telegram target missing for ${postId}`);
  db.prepare('UPDATE post_targets SET enabled=1,updated_at=? WHERE id=?').run(nowIso(), target.id);
  return target.id;
}

const today = await createPost('Today draft', 'AT', '2026-09-14T10:00:00.000Z');
const week = await createPost('Week ready', 'AT', '2026-09-18T10:00:00.000Z');
const review = await createPost('Review me');
const failed = await createPost('Failed post');
const recovery = await createPost('Recovery target');
const archived = await createPost('Archived failure', 'AT', '2026-09-14T12:00:00.000Z');
const trashed = await createPost('Trashed review');
targetFor(today.id); targetFor(week.id); const recoveryTarget = targetFor(recovery.id);

db.prepare(`UPDATE posts SET editorial_stage='APPROVED',status='READY' WHERE id=?`).run(week.id);
db.prepare(`UPDATE posts SET editorial_stage='IN_REVIEW',status='DRAFT' WHERE id=?`).run(review.id);
db.prepare(`UPDATE posts SET editorial_stage='APPROVED',status='FAILED' WHERE id=?`).run(failed.id);
db.prepare(`UPDATE posts SET editorial_stage='DRAFT',status='DRAFT' WHERE id=?`).run(recovery.id);
assert.equal(db.prepare(`UPDATE post_targets SET state='RECOVERY_NEEDED',updated_at=? WHERE id=?`).run(nowIso(), recoveryTarget).changes, 1);
db.prepare(`UPDATE posts SET editorial_stage='ARCHIVED',status='FAILED' WHERE id=?`).run(archived.id);
db.prepare(`UPDATE posts SET editorial_stage='TRASHED',status='DRAFT' WHERE id=?`).run(trashed.id);

const response = await request('GET', `/api/editorial-dashboard?${query}`);
assert.equal(response.statusCode, 200, `dashboard response: ${response.body}`);
const data = response.json();
assert.equal(data.metrics.today, 1, `today metric: ${JSON.stringify(data)}`);
assert.equal(data.metrics.next7Days, 2, `7d metric: ${JSON.stringify(data)}`);
assert.equal(data.metrics.needsReview, 3, `review metric: ${JSON.stringify(data)}`);
assert.equal(data.metrics.ready, 1, `ready metric: ${JSON.stringify(data)}`);
assert.equal(data.metrics.problems, 2, `problems metric: ${JSON.stringify(data)}`);
assert.deepEqual(data.todayItems.map((item) => item.id), [today.id], `today items: ${JSON.stringify(data.todayItems)}`);
assert.equal(data.reviewItems.length, 3, `review items: ${JSON.stringify(data.reviewItems)}`);
assert.ok(data.reviewItems.every((item) => item.review_code), `review codes: ${JSON.stringify(data.reviewItems)}`);
assert.deepEqual(new Set(data.problemItems.map((item) => item.id)), new Set([failed.id, recovery.id]), `problem items: ${JSON.stringify(data.problemItems)}`);
assert.ok(data.problemItems.find((item) => item.id === recovery.id)?.problem_states?.includes('RECOVERY_NEEDED'), `recovery state: ${JSON.stringify(data.problemItems)}`);
assert.deepEqual(data.platformDistribution, [{ platform: 'telegram', count: 2 }], `platforms: ${JSON.stringify(data.platformDistribution)}`);
assert.ok(!data.todayItems.some((item) => item.id === archived.id));
const invalid = await request('GET', '/api/editorial-dashboard?todayFrom=nope&todayTo=nope&weekTo=nope');
assert.equal(invalid.statusCode, 400, invalid.body);

await app.close();
console.log('CX3-007 dashboard API: PASS');
