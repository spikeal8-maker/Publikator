import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-001-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cx3-001-ci-password';
process.env.APP_MASTER_KEY = 'cx3-001-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');

migrate();
const app = await buildApp();
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;

async function request(method, url, payload) {
  return app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
}

const start = new Date('2026-10-01T00:00:00.000Z');
const end = new Date('2026-11-30T00:00:00.000Z');
const posts = [];
for (let index = 0; index < 500; index += 1) {
  const when = new Date(start.getTime() + (index % 60) * 86400000 + (index % 24) * 3600000);
  const response = await request('POST', '/api/posts', {
    projectId,
    title: `Calendar ${String(index).padStart(3, '0')}`,
    body: `Calendar fixture ${index}`,
    scheduleMode: 'AT',
    scheduledAt: when.toISOString(),
    scheduleTimezone: index % 2 ? 'Europe/Berlin' : 'UTC'
  });
  assert.equal(response.statusCode, 201, response.body);
  posts.push(response.json());
}

const sample = posts[0];
const accountId = id('acc');
db.prepare(`INSERT INTO social_accounts
  (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
  VALUES (?,?,?,?,1,?,?)`).run(accountId, 'telegram', 'Calendar channel', 'fixture', nowIso(), nowIso());
db.prepare(`INSERT INTO post_targets
  (id,post_id,account_id,enabled,state,attempts,updated_at)
  VALUES (?,?,?,1,'PENDING',0,?)`).run(id('target'), sample.id, accountId, nowIso());
db.prepare(`INSERT INTO media
  (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
  VALUES (?,?,?,?,?,?,?,?,?,?,0)`).run(id('med'), sample.id, 'calendar.jpg', `${sample.id}/calendar.jpg`, 'image/jpeg', 10, 1200, 630, 'a'.repeat(64), nowIso());
db.prepare(`UPDATE posts SET source_type='google_sheets',source_ref='calendar-fixture' WHERE id=?`).run(sample.id);

db.prepare("UPDATE posts SET editorial_stage='ARCHIVED' WHERE id=?").run(posts[1].id);
db.prepare("UPDATE posts SET editorial_stage='TRASHED' WHERE id=?").run(posts[2].id);
const manual = await request('POST', '/api/posts', {
  projectId, title: 'Manual unscheduled', body: 'No calendar instant', scheduleMode: 'MANUAL'
});
assert.equal(manual.statusCode, 201, manual.body);

const calendar = await request('GET', `/api/calendar?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`);
assert.equal(calendar.statusCode, 200, calendar.body);
const body = calendar.json();
assert.equal(body.count, 498);
assert.equal(body.items.length, 498);
assert.ok(!body.items.some((item) => item.id === posts[1].id));
assert.ok(!body.items.some((item) => item.id === posts[2].id));
assert.ok(!body.items.some((item) => item.id === manual.json().id));
for (let index = 1; index < body.items.length; index += 1) {
  assert.ok(body.items[index - 1].scheduled_at_utc <= body.items[index].scheduled_at_utc);
}
const projected = body.items.find((item) => item.id === sample.id);
assert.ok(projected);
assert.equal(projected.thumbnail_path, `${sample.id}/calendar.jpg`);
assert.deepEqual(projected.platforms, ['telegram']);
assert.equal(projected.source_type, 'google_sheets');
assert.equal(projected.source_ref, 'calendar-fixture');
assert.equal(projected.schedule_timezone, 'UTC');
assert.equal(projected.publication_kind, 'FEED');
assert.equal(projected.content_format, 'IMAGE');

const tooWide = await request('GET', `/api/calendar?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(new Date(start.getTime() + 94 * 86400000).toISOString())}`);
assert.equal(tooWide.statusCode, 400, tooWide.body);
const backwards = await request('GET', `/api/calendar?from=${encodeURIComponent(end.toISOString())}&to=${encodeURIComponent(start.toISOString())}`);
assert.equal(backwards.statusCode, 400, backwards.body);

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CX3-001',
  sixtyDayProjection: body.items.length,
  archivedAndTrashExcluded: true,
  manualUnscheduledExcluded: true,
  thumbnailPlatformSourceTimezone: true,
  rangeGuard: true
}, null, 2));

await app.close();
db.close();
await fs.rm(dataDir, { recursive: true, force: true });
