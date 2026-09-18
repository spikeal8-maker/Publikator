import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-002-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cx3-002-ci-password';
process.env.APP_MASTER_KEY = 'cx3-002-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();
await app.ready();

const unauthorized = await app.inject({ method: 'GET', url: '/api/content-library' });
assert.equal(unauthorized.statusCode, 401, unauthorized.body);
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers['set-cookie']).split(';')[0];
const projectId = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id;
async function request(method, url, payload) { return app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) }); }

const posts = [];
for (let index = 0; index < 130; index += 1) {
  const scheduled = index >= 20 && index < 30;
  const response = await request('POST', '/api/posts', {
    projectId,
    title: index === 77 ? 'Unique library needle' : `Library ${String(index).padStart(3, '0')}`,
    body: `Library fixture ${index}`,
    scheduleMode: scheduled ? 'AT' : 'MANUAL',
    ...(scheduled ? { scheduledAt: new Date(Date.UTC(2026, 9, 1 + (index - 20), 12)).toISOString(), scheduleTimezone: 'UTC' } : {})
  });
  assert.equal(response.statusCode, 201, response.body);
  posts.push(response.json());
}

for (let index = 0; index < 10; index += 1) db.prepare("UPDATE posts SET source_type='google_sheets',source_ref=? WHERE id=?").run(`sheet-${index}`, posts[index].id);
for (let index = 10; index < 20; index += 1) db.prepare("UPDATE posts SET status='READY',editorial_stage='APPROVED' WHERE id=?").run(posts[index].id);
for (let index = 30; index < 40; index += 1) db.prepare("UPDATE posts SET status='PUBLISHED',editorial_stage='APPROVED' WHERE id=?").run(posts[index].id);
for (let index = 40; index < 45; index += 1) db.prepare("UPDATE posts SET status='FAILED' WHERE id=?").run(posts[index].id);
for (let index = 50; index < 55; index += 1) db.prepare("UPDATE posts SET publication_kind='STORY',content_format='IMAGE' WHERE id=?").run(posts[index].id);
for (let index = 55; index < 60; index += 1) db.prepare("UPDATE posts SET publication_kind='SHORT',content_format='VERTICAL_VIDEO' WHERE id=?").run(posts[index].id);
for (let index = 60; index < 65; index += 1) db.prepare("UPDATE posts SET content_format='VIDEO' WHERE id=?").run(posts[index].id);
db.prepare("UPDATE posts SET editorial_stage='ARCHIVED' WHERE id=?").run(posts[128].id);
db.prepare("UPDATE posts SET editorial_stage='TRASHED' WHERE id=?").run(posts[129].id);

const sample = posts[0];
const accountId = id('acc');
db.prepare(`INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`)
  .run(accountId, 'telegram', 'Library channel', 'fixture', nowIso(), nowIso());
db.prepare(`INSERT INTO post_targets (id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (?,?,?,1,'PENDING',0,?)`)
  .run(id('target'), sample.id, accountId, nowIso());
db.prepare(`INSERT INTO media (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
  VALUES (?,?,?,?,?,?,?,?,?,?,0)`).run(id('med'), sample.id, 'library.jpg', `${sample.id}/library.jpg`, 'image/jpeg', 10, 1200, 630, 'b'.repeat(64), nowIso());
const problemAccount = id('acc');
db.prepare(`INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`)
  .run(problemAccount, 'vk', 'Problem channel', 'fixture', nowIso(), nowIso());
db.prepare(`INSERT INTO post_targets (id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (?,?,?,1,'RECOVERY_NEEDED',1,?)`)
  .run(id('target'), posts[45].id, problemAccount, nowIso());

const all = await request('GET', '/api/content-library?view=all&page=1&pageSize=25');
assert.equal(all.statusCode, 200, all.body);
const allBody = all.json();
assert.equal(allBody.total, 128);
assert.equal(allBody.items.length, 25);
assert.equal(allBody.totalPages, 6);
const page2 = (await request('GET', '/api/content-library?view=all&page=2&pageSize=25')).json();
assert.equal(new Set([...allBody.items, ...page2.items].map((item) => item.id)).size, 50);

const inbox = (await request('GET', '/api/content-library?view=inbox&pageSize=100')).json();
assert.equal(inbox.total, 10);
const ready = (await request('GET', '/api/content-library?view=ready&pageSize=100')).json();
assert.equal(ready.total, 10);
const scheduled = (await request('GET', '/api/content-library?view=scheduled&pageSize=100')).json();
assert.equal(scheduled.total, 10);
const published = (await request('GET', '/api/content-library?view=published&pageSize=100')).json();
assert.equal(published.total, 10);
const problems = (await request('GET', '/api/content-library?view=problems&pageSize=100')).json();
assert.equal(problems.total, 6);

const stories = (await request('GET', '/api/content-library?format=stories&pageSize=100')).json();
assert.equal(stories.total, 5);
const shorts = (await request('GET', '/api/content-library?format=shorts&pageSize=100')).json();
assert.equal(shorts.total, 5);
const video = (await request('GET', '/api/content-library?format=video&pageSize=100')).json();
assert.equal(video.total, 10);
const search = (await request('GET', '/api/content-library?search=Unique%20library%20needle&pageSize=100')).json();
assert.equal(search.total, 1);
assert.equal(search.items[0].id, posts[77].id);

const sampleProjection = (await request('GET', '/api/content-library?view=inbox&search=Library%20000&pageSize=100')).json().items[0];
assert.equal(sampleProjection.thumbnail_path, `${sample.id}/library.jpg`);
assert.deepEqual(sampleProjection.platforms, ['telegram']);
assert.equal(sampleProjection.source_type, 'google_sheets');
assert.ok(!allBody.items.some((item) => [posts[128].id, posts[129].id].includes(item.id)));

for (const url of ['/api/content-library?view=nope', '/api/content-library?format=nope', '/api/content-library?pageSize=101']) {
  const response = await request('GET', url);
  assert.equal(response.statusCode, 400, response.body);
}

const html = await fs.readFile(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
const frontend = await fs.readFile(path.join(process.cwd(), 'public', 'content-library-v3.js'), 'utf8');
for (const required of ['id="content-library-nav"', '/content-library-v3.css', '/content-library-v3.js']) assert.ok(html.includes(required), required);
for (const required of ['libraryLayout', 'librarySelected', "['all','Все']", "['problems','Проблемы']", "['stories','Истории']", "['shorts','Короткие видео']", "['video','Видео']", 'libraryPageSize', 'library-open open-post']) assert.ok(frontend.includes(required), required);

console.log(JSON.stringify({ ok: true, checkpoint: 'CX3-002', totalActive: allBody.total, pagination: true, views: true, formatFilters: true, search: true, gridList: true, bulkSelection: true, inspectorReuse: true }, null, 2));
await app.close();
db.close();
await fs.rm(dataDir, { recursive: true, force: true });
