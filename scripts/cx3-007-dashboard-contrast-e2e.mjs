import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-007-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cx3-007-ci-password';
process.env.APP_MASTER_KEY = 'cx3-007-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { buildApp } = await import('../dist/app.js');

migrate();
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
const createdAt = nowIso();
db.prepare(`INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`).run('acc_dashboard_tg', 'telegram', 'Dashboard TG', encryptJson({ token: 'mock' }), createdAt, createdAt);

const app = await buildApp();
await app.ready();
const anonymous = await app.inject({ method: 'GET', url: '/api/editorial-dashboard?todayFrom=2026-09-14T00:00:00.000Z&todayTo=2026-09-15T00:00:00.000Z&weekTo=2026-09-21T00:00:00.000Z' });
assert.equal(anonymous.statusCode, 401);
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];
const request = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });

async function createPost(title, scheduleMode = 'MANUAL', scheduledAt = null) {
  const payload = { projectId, title, body: `${title} body`, scheduleMode };
  if (scheduledAt) payload.scheduledAt = scheduledAt;
  const response = await request('POST', '/api/posts', payload);
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

const today = await createPost('Today draft', 'AT', '2026-09-14T10:00:00.000Z');
const week = await createPost('Week ready', 'AT', '2026-09-18T10:00:00.000Z');
const review = await createPost('Review me');
const failed = await createPost('Failed post');
const recovery = await createPost('Recovery target');
const archived = await createPost('Archived failure', 'AT', '2026-09-14T12:00:00.000Z');
const trashed = await createPost('Trashed review');

db.prepare(`UPDATE posts SET editorial_stage='APPROVED',status='READY' WHERE id=?`).run(week.id);
db.prepare(`UPDATE posts SET editorial_stage='IN_REVIEW',status='DRAFT' WHERE id=?`).run(review.id);
db.prepare(`UPDATE posts SET editorial_stage='APPROVED',status='FAILED' WHERE id=?`).run(failed.id);
db.prepare(`UPDATE posts SET editorial_stage='DRAFT',status='DRAFT' WHERE id=?`).run(recovery.id);
db.prepare(`UPDATE post_targets SET state='RECOVERY_NEEDED' WHERE post_id=?`).run(recovery.id);
db.prepare(`UPDATE posts SET editorial_stage='ARCHIVED',status='FAILED' WHERE id=?`).run(archived.id);
db.prepare(`UPDATE posts SET editorial_stage='TRASHED',status='DRAFT' WHERE id=?`).run(trashed.id);

const url = '/api/editorial-dashboard?todayFrom=2026-09-14T00:00:00.000Z&todayTo=2026-09-15T00:00:00.000Z&weekTo=2026-09-21T00:00:00.000Z';
const response = await request('GET', url);
assert.equal(response.statusCode, 200, response.body);
const data = response.json();
assert.equal(data.metrics.today, 1);
assert.equal(data.metrics.next7Days, 2);
assert.equal(data.metrics.needsReview, 3);
assert.equal(data.metrics.ready, 1);
assert.equal(data.metrics.problems, 2);
assert.deepEqual(data.todayItems.map((item) => item.id), [today.id]);
assert.equal(data.reviewItems.length, 3);
assert.ok(data.reviewItems.every((item) => item.review_code));
assert.deepEqual(new Set(data.problemItems.map((item) => item.id)), new Set([failed.id, recovery.id]));
assert.ok(data.problemItems.find((item) => item.id === recovery.id).problem_states.includes('RECOVERY_NEEDED'));
assert.deepEqual(data.platformDistribution, [{ platform: 'telegram', count: 2 }]);
assert.ok(!data.todayItems.some((item) => item.id === archived.id));

const invalid = await request('GET', '/api/editorial-dashboard?todayFrom=nope&todayTo=nope&weekTo=nope');
assert.equal(invalid.statusCode, 400);

const css = await fs.readFile(new URL('../public/theme-v3.css', import.meta.url), 'utf8');
const darkCss = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
function color(source, name) {
  const match = source.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `missing ${name}`);
  return match[1];
}
function rgb(hex) { return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255); }
function luminance(hex) {
  return rgb(hex).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a, b) { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); }
assert.ok(contrast(color(css, '--text-primary'), color(css, '--bg')) >= 7);
assert.ok(contrast(color(css, '--text-secondary'), color(css, '--surface')) >= 4.5);
assert.ok(contrast(color(darkCss, '--text-primary'), color(darkCss, '--bg')) >= 7);
assert.ok(contrast(color(darkCss, '--text-secondary'), color(darkCss, '--surface')) >= 4.5);
for (const marker of ['--success', '--warning', '--danger', '.badge.PUBLISHED::before', '.badge.FAILED::before', ':focus-visible']) assert.ok(css.includes(marker), `theme marker missing: ${marker}`);

const dashboardSource = await fs.readFile(new URL('../public/dashboard-v3.js', import.meta.url), 'utf8');
for (const marker of ['Сегодня', '7 дней', 'Нужно проверить', 'Проблемы', 'status-chip', '.open-post']) assert.ok(dashboardSource.includes(marker), `dashboard marker missing: ${marker}`);
const index = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
assert.ok(index.includes('/theme-v3.css'));
assert.ok(index.includes('/dashboard-v3.css'));
assert.ok(index.includes('/dashboard-v3.js'));

await app.close();
console.log('CX3-007 dashboard and contrast: PASS');
