import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { createSessionToken, decryptJson, encryptJson, securePasswordEqual, verifySessionToken } from '../crypto.js';
import { db, event, id, nowIso, type Platform } from '../db.js';
import { deleteMedia, listMedia, saveImage } from '../media.js';
import { ensureTargets, publishPost, publishTarget, refreshPostStatus, setTargetSelection } from '../publisher.js';

const PLATFORMS = new Set<Platform>(['telegram','vk','max','instagram']);
const loginFailures = new Map<string, { count: number; windowStartedAt: number; blockedUntil: number }>();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function bodyObject(body: unknown): Record<string, any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, any>;
}

function postView(row: any): any {
  const media = listMedia(row.id);
  const targets = db.prepare(`SELECT pt.id, pt.account_id, pt.enabled, pt.override_text, pt.state, pt.attempts,
    pt.next_attempt_at, pt.external_id, pt.external_url, pt.last_error, pt.published_at,
    a.platform, a.name AS account_name
    FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.post_id=? ORDER BY a.platform,a.name`).all(row.id);
  return { ...row, media, targets };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, service: 'publikator', time: nowIso() }));

  app.post('/api/auth/login', async (request, reply) => {
    const key = request.ip;
    const now = Date.now();
    const failure = loginFailures.get(key);
    if (failure && failure.blockedUntil > now) return reply.code(429).send({ error: 'Слишком много неудачных попыток. Повторите вход позже.' });
    const body = bodyObject(request.body);
    if (typeof body.password !== 'string' || !securePasswordEqual(body.password)) {
      const inWindow = Boolean(failure && now - failure.windowStartedAt < LOGIN_WINDOW_MS && failure.blockedUntil <= now);
      const nextCount = inWindow ? failure!.count + 1 : 1;
      const windowStartedAt = inWindow ? failure!.windowStartedAt : now;
      loginFailures.set(key, { count: nextCount, windowStartedAt, blockedUntil: nextCount >= LOGIN_MAX_FAILURES ? now + LOGIN_WINDOW_MS : 0 });
      return reply.code(401).send({ error: 'Неверный пароль' });
    }
    loginFailures.delete(key);
    const token = createSessionToken();
    reply.setCookie('publikator_session', token, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.publicBaseUrl.startsWith('https://'), maxAge: Math.floor(config.sessionTtlMs / 1000) });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie('publikator_session', { path: '/' });
    return { ok: true };
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/') || request.url === '/api/health' || request.url === '/api/auth/login') return;
    if (!verifySessionToken(request.cookies.publikator_session)) return reply.code(401).send({ error: 'Требуется вход' });
  });

  app.get('/api/dashboard', async () => {
    const counts = db.prepare('SELECT status, COUNT(*) AS count FROM posts GROUP BY status').all();
    const targetCounts = db.prepare('SELECT state, COUNT(*) AS count FROM post_targets GROUP BY state').all();
    const recentEvents = db.prepare('SELECT * FROM publication_events ORDER BY created_at DESC LIMIT 30').all();
    return { counts, targetCounts, recentEvents };
  });

  app.get('/api/projects', async () => db.prepare('SELECT * FROM projects ORDER BY name').all());
  app.post('/api/projects', async (request, reply) => {
    const body = bodyObject(request.body);
    const name = String(body.name || '').trim();
    const slug = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    if (!name || !slug) return reply.code(400).send({ error: 'Нужны name и slug' });
    const projectId = id('prj');
    db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)').run(projectId, name, slug, nowIso());
    return reply.code(201).send(db.prepare('SELECT * FROM projects WHERE id=?').get(projectId));
  });

  app.get('/api/accounts', async () => {
    const rows = db.prepare('SELECT id,platform,name,enabled,created_at,updated_at FROM social_accounts ORDER BY platform,name').all();
    return rows;
  });
  app.post('/api/accounts', async (request, reply) => {
    const body = bodyObject(request.body);
    const platform = String(body.platform || '') as Platform;
    if (!PLATFORMS.has(platform)) return reply.code(400).send({ error: 'Неизвестная площадка' });
    const name = String(body.name || '').trim();
    if (!name || !body.credentials || typeof body.credentials !== 'object') return reply.code(400).send({ error: 'Нужны name и credentials' });
    const accountId = id('acc');
    const now = nowIso();
    db.prepare('INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)')
      .run(accountId, platform, name, encryptJson(body.credentials), now, now);
    return reply.code(201).send({ id: accountId, platform, name, enabled: 1 });
  });
  app.patch('/api/accounts/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const body = bodyObject(request.body);
    const current = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(params.id) as any;
    if (!current) return reply.code(404).send({ error: 'Аккаунт не найден' });
    const name = body.name === undefined ? current.name : String(body.name).trim();
    const enabled = body.enabled === undefined ? current.enabled : body.enabled ? 1 : 0;
    const credentials = body.credentials === undefined ? current.credentials_encrypted : encryptJson(body.credentials);
    db.prepare('UPDATE social_accounts SET name=?,enabled=?,credentials_encrypted=?,updated_at=? WHERE id=?').run(name, enabled, credentials, nowIso(), params.id);
    return { ok: true };
  });
  app.get('/api/accounts/:id/credentials-check', async (request, reply) => {
    const params = request.params as { id: string };
    const row = db.prepare('SELECT credentials_encrypted FROM social_accounts WHERE id=?').get(params.id) as any;
    if (!row) return reply.code(404).send({ error: 'Аккаунт не найден' });
    const value = decryptJson<Record<string, unknown>>(row.credentials_encrypted);
    return { ok: true, fields: Object.keys(value) };
  });

  app.get('/api/posts', async (request) => {
    const query = request.query as { status?: string; projectId?: string };
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.status) { conditions.push('p.status=?'); values.push(query.status); }
    if (query.projectId) { conditions.push('p.project_id=?'); values.push(query.projectId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT p.*, pr.name AS project_name,
      (SELECT COUNT(*) FROM media m WHERE m.post_id=p.id) AS media_count
      FROM posts p JOIN projects pr ON pr.id=p.project_id ${where} ORDER BY p.created_at DESC`).all(...values);
    return rows;
  });
  app.get('/api/posts/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const row = db.prepare('SELECT p.*, pr.name AS project_name FROM posts p JOIN projects pr ON pr.id=p.project_id WHERE p.id=?').get(params.id) as any;
    if (!row) return reply.code(404).send({ error: 'Пост не найден' });
    ensureTargets(params.id);
    return postView(row);
  });
  app.post('/api/posts', async (request, reply) => {
    const body = bodyObject(request.body);
    const projectId = String(body.projectId || '');
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) return reply.code(400).send({ error: 'Проект не найден' });
    const title = String(body.title || '').trim();
    const text = String(body.body || '').trim();
    if (!title || !text) return reply.code(400).send({ error: 'Заголовок и текст обязательны' });
    const postId = id('post');
    const mode = ['MANUAL','AT','QUEUE'].includes(body.scheduleMode) ? body.scheduleMode : 'MANUAL';
    const scheduledAt = mode === 'AT' && body.scheduledAt ? new Date(body.scheduledAt).toISOString() : null;
    const now = nowIso();
    db.prepare('INSERT INTO posts (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(postId, projectId, title, text, 'DRAFT', mode, scheduledAt, now, now);
    ensureTargets(postId);
    return reply.code(201).send(postView(db.prepare('SELECT * FROM posts WHERE id=?').get(postId)));
  });
  app.patch('/api/posts/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const body = bodyObject(request.body);
    const current = db.prepare('SELECT * FROM posts WHERE id=?').get(params.id) as any;
    if (!current) return reply.code(404).send({ error: 'Пост не найден' });
    if (['PUBLISHING','PUBLISHED'].includes(current.status)) return reply.code(409).send({ error: 'Нельзя редактировать публикующийся или опубликованный пост' });
    const title = body.title === undefined ? current.title : String(body.title).trim();
    const text = body.body === undefined ? current.body : String(body.body).trim();
    const mode = body.scheduleMode === undefined ? current.schedule_mode : String(body.scheduleMode);
    if (!['MANUAL','AT','QUEUE'].includes(mode)) return reply.code(400).send({ error: 'Неверный scheduleMode' });
    const scheduledAt = mode === 'AT' ? (body.scheduledAt ? new Date(body.scheduledAt).toISOString() : current.scheduled_at) : null;
    db.prepare('UPDATE posts SET title=?,body=?,schedule_mode=?,scheduled_at=?,updated_at=? WHERE id=?').run(title, text, mode, scheduledAt, nowIso(), params.id);
    return { ok: true };
  });

  app.put('/api/posts/:id/targets', async (request, reply) => {
    const params = request.params as { id: string };
    const post = db.prepare('SELECT status FROM posts WHERE id=?').get(params.id) as { status: string } | undefined;
    if (!post) return reply.code(404).send({ error: 'Пост не найден' });
    if (['PUBLISHING','PUBLISHED'].includes(post.status)) return reply.code(409).send({ error: 'Нельзя менять площадки после начала публикации' });
    const body = bodyObject(request.body);
    if (!Array.isArray(body.accountIds) || body.accountIds.some((value: unknown) => typeof value !== 'string')) return reply.code(400).send({ error: 'accountIds должен быть массивом строк' });
    setTargetSelection(params.id, body.accountIds as string[]);
    return { ok: true, targets: (postView(db.prepare('SELECT * FROM posts WHERE id=?').get(params.id)) as any).targets };
  });

  app.post('/api/posts/:id/media', async (request, reply) => {
    const params = request.params as { id: string };
    if (!db.prepare('SELECT 1 FROM posts WHERE id=?').get(params.id)) return reply.code(404).send({ error: 'Пост не найден' });
    const part = await request.file({ limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
    if (!part) return reply.code(400).send({ error: 'Файл не передан' });
    if (!part.mimetype.startsWith('image/')) return reply.code(400).send({ error: 'Допускаются только изображения' });
    const buffer = await part.toBuffer();
    const saved = await saveImage(params.id, part.filename, buffer);
    return reply.code(201).send(saved);
  });
  app.delete('/api/media/:id', async (request) => {
    const params = request.params as { id: string };
    await deleteMedia(params.id);
    return { ok: true };
  });

  app.post('/api/posts/:id/ready', async (request, reply) => {
    const params = request.params as { id: string };
    const post = db.prepare('SELECT * FROM posts WHERE id=?').get(params.id) as any;
    if (!post) return reply.code(404).send({ error: 'Пост не найден' });
    const mediaCount = db.prepare('SELECT COUNT(*) AS count FROM media WHERE post_id=?').get(params.id) as { count: number };
    if (mediaCount.count < 1) return reply.code(409).send({ error: 'Публикация без изображения запрещена' });
    ensureTargets(params.id);
    const accountCount = db.prepare("SELECT COUNT(*) AS count FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id WHERE pt.post_id=? AND pt.enabled=1 AND a.enabled=1").get(params.id) as { count: number };
    if (accountCount.count < 1) return reply.code(409).send({ error: 'Не выбрана ни одна активная соцсеть' });
    db.prepare("UPDATE posts SET status='READY',updated_at=? WHERE id=?").run(nowIso(), params.id);
    event({ postId: params.id, type: 'post_ready', message: 'Пост готов к публикации' });
    return { ok: true };
  });
  app.post('/api/posts/:id/publish-now', async (request, reply) => {
    const params = request.params as { id: string };
    try { await publishPost(params.id); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
    return { ok: true, post: postView(db.prepare('SELECT * FROM posts WHERE id=?').get(params.id)) };
  });
  app.post('/api/targets/:id/retry', async (request, reply) => {
    const params = request.params as { id: string };
    const target = db.prepare('SELECT pt.post_id FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id WHERE pt.id=? AND pt.enabled=1 AND a.enabled=1').get(params.id) as { post_id: string } | undefined;
    if (!target) return reply.code(409).send({ error: 'Цель отключена или не найдена' });
    db.prepare("UPDATE post_targets SET state='PENDING',next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE id=?").run(nowIso(), params.id);
    await publishTarget(params.id);
    refreshPostStatus(target.post_id);
    return { ok: true };
  });

  app.get('/api/schedules', async () => db.prepare('SELECT s.*, p.name AS project_name FROM schedule_slots s JOIN projects p ON p.id=s.project_id ORDER BY project_name,weekday,time_hhmm').all());
  app.post('/api/schedules', async (request, reply) => {
    const body = bodyObject(request.body);
    const projectId = String(body.projectId || '');
    const weekday = Number(body.weekday);
    const time = String(body.time || '');
    const timezone = String(body.timezone || 'Europe/Moscow');
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) return reply.code(400).send({ error: 'Проект не найден' });
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return reply.code(400).send({ error: 'Неверные weekday/time' });
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date()); } catch { return reply.code(400).send({ error: 'Неверная timezone' }); }
    const slotId = id('slot');
    db.prepare('INSERT INTO schedule_slots (id,project_id,weekday,time_hhmm,timezone,enabled,created_at) VALUES (?,?,?,?,?,1,?)').run(slotId, projectId, weekday, time, timezone, nowIso());
    return reply.code(201).send(db.prepare('SELECT * FROM schedule_slots WHERE id=?').get(slotId));
  });

  app.delete('/api/schedules/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const result = db.prepare('DELETE FROM schedule_slots WHERE id=?').run(params.id);
    if (result.changes === 0) return reply.code(404).send({ error: 'Слот не найден' });
    return { ok: true };
  });

  app.get('/api/events', async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit || 100)));
    return db.prepare('SELECT e.*, p.title AS post_title, a.platform, a.name AS account_name FROM publication_events e LEFT JOIN posts p ON p.id=e.post_id LEFT JOIN social_accounts a ON a.id=e.account_id ORDER BY e.created_at DESC LIMIT ?').all(limit);
  });

  app.post('/api/backups', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = `${config.backupDir}/publikator-${stamp}.sqlite`;
    await db.backup(destination);
    event({ type: 'backup_created', message: `Создана резервная копия ${destination}` });
    return { ok: true, file: destination.split('/').pop() };
  });

  app.get('/api/backups', async () => {
    const files = await fs.readdir(config.backupDir).catch(() => [] as string[]);
    return files.filter((name) => name.endsWith('.sqlite')).sort().reverse();
  });
}
