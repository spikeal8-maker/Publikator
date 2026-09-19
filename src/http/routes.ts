import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { createSessionToken, decryptJson, encryptJson, securePasswordEqual, verifySessionToken } from '../crypto.js';
import { db, event, id, nowIso, type Platform } from '../db.js';
import { deleteMediaVersioned, listMedia, saveImageVersioned } from '../media.js';
import { commitContentEdit, createInitialContentRevision, markReadyRevision, snapshotContentRevision } from '../content-versioning.js';
import { contentMutationError, expectedContentVersion } from './content-version.js';
import {
  confirmRecoveryNotPublished,
  confirmRecoveryPublished,
  ensureTargets,
  preflightRevision,
  publishPost,
  retryFailedTarget,
  setTargetSelection
} from '../publisher.js';
import { testConnection } from '../platforms/connection-test.js';
import { normalizeIanaTimezone, resolveExactSchedule, resolveScheduleInput } from '../schedule-time.js';
import { parseRichTextJson, plainTextToRichText, richTextToPlain, serializeRichText } from '../rich-text.js';

type ScheduleMutation = { scheduledAt: string | null; scheduledAtUtc: string | null; scheduleTimezone: string | null };

function scheduleMutation(mode: string, body: Record<string, any>, current?: any): ScheduleMutation {
  if (mode !== 'AT') return { scheduledAt: null, scheduledAtUtc: null, scheduleTimezone: null };
  const hasTimeInput = Boolean(body.scheduledAt || body.scheduledAtLocal);
  if (hasTimeInput) {
    const resolved = resolveScheduleInput({ scheduledAt: body.scheduledAt, scheduledAtLocal: body.scheduledAtLocal,
      scheduleTimezone: body.scheduleTimezone, ambiguousOffset: body.ambiguousOffset });
    return { scheduledAt: resolved.scheduledAtUtc, scheduledAtUtc: resolved.scheduledAtUtc, scheduleTimezone: resolved.scheduleTimezone };
  }
  const currentUtc = current?.scheduled_at_utc ?? current?.scheduled_at;
  if (!currentUtc) throw new Error('AT schedule requires an exact or local scheduled time');
  const resolved = resolveExactSchedule(currentUtc, current?.schedule_timezone ?? 'UTC');
  return { scheduledAt: resolved.scheduledAtUtc, scheduledAtUtc: resolved.scheduledAtUtc, scheduleTimezone: resolved.scheduleTimezone };
}

const PLATFORMS = new Set<Platform>(['telegram','vk','max','instagram']);
const loginFailures = new Map<string, { count: number; windowStartedAt: number; blockedUntil: number }>();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const IMMUTABLE_POST_STATUSES = new Set(['PUBLISHING','PUBLISHED','PARTIAL']);

function bodyObject(body: unknown): Record<string, any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, any>;
}

function postView(row: any): any {
  const media = listMedia(row.id);
  const targetRows = db.prepare(`SELECT pt.id, pt.account_id, pt.enabled, pt.override_text, pt.state, pt.attempts,
    pt.next_attempt_at, pt.external_id, pt.external_url, pt.last_error, pt.published_at,
    a.platform, a.name AS account_name,
    tr.text_rich_json, tr.text_plain, tr.publication_kind AS rendition_publication_kind,
    tr.content_format AS rendition_content_format, tr.media_plan_json, tr.options_json
    FROM post_targets pt
    JOIN social_accounts a ON a.id=pt.account_id
    LEFT JOIN target_renditions tr ON tr.target_id=pt.id
    WHERE pt.post_id=? ORDER BY a.platform,a.name`).all(row.id) as any[];
  const targets = targetRows.map((target) => ({
    ...target,
    textRich: target.text_rich_json ? parseRichTextJson(String(target.text_rich_json)) : null,
    textPlain: target.text_plain ?? null
  }));
  const bodyRich = parseRichTextJson(String(row.body_rich_json));
  return { ...row, bodyRich, media, targets };
}

function resolvedPostBody(input: Record<string, any>, current?: any): { body: string; bodyRichJson: string } {
  if (Object.prototype.hasOwnProperty.call(input, 'bodyRich')) {
    const bodyRichJson = serializeRichText(input.bodyRich);
    return { body: richTextToPlain(input.bodyRich), bodyRichJson };
  }
  if (Object.prototype.hasOwnProperty.call(input, 'body')) {
    const body = String(input.body ?? '').trim();
    return { body, bodyRichJson: serializeRichText(plainTextToRichText(body)) };
  }
  if (current) {
    const document = parseRichTextJson(String(current.body_rich_json));
    return { body: richTextToPlain(document), bodyRichJson: serializeRichText(document) };
  }
  return { body: '', bodyRichJson: serializeRichText(plainTextToRichText('')) };
}

function projectDefaultTargetAccountIds(projectId: string): string[] {
  return (db.prepare(`SELECT account_id FROM project_default_targets
    WHERE project_id=? ORDER BY created_at,account_id`).all(projectId) as Array<{ account_id: string }>)
    .map((row) => row.account_id);
}

function projectView(row: any): any {
  return { ...row, defaultTargetAccountIds: projectDefaultTargetAccountIds(String(row.id)) };
}

function normalizedProjectDefaultTargetAccountIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('defaultTargetAccountIds должен быть массивом строк');
  }
  const accountIds = [...new Set(value as string[])];
  const exists = db.prepare('SELECT 1 FROM social_accounts WHERE id=?');
  for (const accountId of accountIds) {
    if (!exists.get(accountId)) throw new Error(`Неизвестный account id: ${accountId}`);
  }
  return accountIds;
}

function replaceProjectDefaultTargets(projectId: string, accountIds: string[], createdAt: string): void {
  db.prepare('DELETE FROM project_default_targets WHERE project_id=?').run(projectId);
  const insert = db.prepare(`INSERT INTO project_default_targets (project_id,account_id,created_at)
    VALUES (?,?,?)`);
  for (const accountId of accountIds) insert.run(projectId, accountId, createdAt);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    service: 'publikator',
    buildSha: config.appBuildSha || null,
    schemaVersion: Number(db.pragma('user_version', { simple: true }) ?? 0),
    time: nowIso()
  }));

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

  app.get('/api/projects', async () =>
    (db.prepare('SELECT * FROM projects ORDER BY name').all() as any[]).map(projectView)
  );
  app.post('/api/projects', async (request, reply) => {
    const body = bodyObject(request.body);
    const name = String(body.name || '').trim();
    const slug = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    if (!name || !slug) return reply.code(400).send({ error: 'Нужны name и slug' });

    let defaultTimezone: string;
    try {
      if (body.defaultTimezone !== undefined && typeof body.defaultTimezone !== 'string') {
        throw new Error('defaultTimezone должен быть строкой IANA timezone');
      }
      defaultTimezone = normalizeIanaTimezone(body.defaultTimezone ?? 'UTC');
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    const projectId = id('prj');
    const created = db.transaction(() => {
      const createdAt = nowIso();
      db.prepare('INSERT INTO projects (id,name,slug,default_timezone,created_at) VALUES (?,?,?,?,?)')
        .run(projectId, name, slug, defaultTimezone, createdAt);
      db.prepare(`INSERT INTO project_default_targets (project_id,account_id,created_at)
        SELECT ?,id,? FROM social_accounts WHERE enabled=1`).run(projectId, createdAt);
      return db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    })();
    return reply.code(201).send(projectView(created));
  });
  app.patch('/api/projects/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const body = bodyObject(request.body);
    const current = db.prepare('SELECT * FROM projects WHERE id=?').get(params.id) as any;
    if (!current) return reply.code(404).send({ error: 'Проект не найден' });

    const name = body.name === undefined ? current.name : String(body.name).trim();
    if (!name) return reply.code(400).send({ error: 'name не должен быть пустым' });

    let defaultTimezone = String(current.default_timezone);
    if (body.defaultTimezone !== undefined) {
      if (typeof body.defaultTimezone !== 'string') {
        return reply.code(400).send({ error: 'defaultTimezone должен быть строкой IANA timezone' });
      }
      try {
        defaultTimezone = normalizeIanaTimezone(body.defaultTimezone);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    }

    let defaultTargetAccountIds: string[] | undefined;
    if (body.defaultTargetAccountIds !== undefined) {
      try {
        defaultTargetAccountIds = normalizedProjectDefaultTargetAccountIds(body.defaultTargetAccountIds);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    }

    const updated = db.transaction(() => {
      db.prepare('UPDATE projects SET name=?,default_timezone=? WHERE id=?')
        .run(name, defaultTimezone, params.id);
      if (defaultTargetAccountIds !== undefined) {
        replaceProjectDefaultTargets(params.id, defaultTargetAccountIds, nowIso());
        db.prepare('UPDATE projects SET default_targets_explicit=1 WHERE id=?').run(params.id);
      }
      return db.prepare('SELECT * FROM projects WHERE id=?').get(params.id);
    })();
    return projectView(updated);
  });

  app.get('/api/accounts', async () => {
    const rows = db.prepare('SELECT id,platform,name,enabled,created_at,updated_at FROM social_accounts ORDER BY platform,name').all();
    return rows;
  });
  app.post('/api/accounts/test', async (request, reply) => {
    const body = bodyObject(request.body);
    const platform = String(body.platform || '') as Platform;
    if (!PLATFORMS.has(platform)) return reply.code(400).send({ error: 'Неизвестная площадка' });
    if (!body.credentials || typeof body.credentials !== 'object' || Array.isArray(body.credentials)) return reply.code(400).send({ error: 'Нужны credentials' });
    try {
      return await testConnection(platform, body.credentials as Record<string, unknown>);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post('/api/accounts', async (request, reply) => {
    const body = bodyObject(request.body);
    const platform = String(body.platform || '') as Platform;
    if (!PLATFORMS.has(platform)) return reply.code(400).send({ error: 'Неизвестная площадка' });
    const name = String(body.name || '').trim();
    if (!name || !body.credentials || typeof body.credentials !== 'object') return reply.code(400).send({ error: 'Нужны name и credentials' });
    const accountId = id('acc');
    const now = nowIso();
    db.transaction(() => {
      db.prepare('INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)')
        .run(accountId, platform, name, encryptJson(body.credentials), now, now);
      db.prepare(`INSERT INTO project_default_targets (project_id,account_id,created_at)
        SELECT id,?,? FROM projects WHERE default_targets_explicit=0`)
        .run(accountId, now);
    })();
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
  app.post('/api/accounts/:id/test', async (request, reply) => {
    const params = request.params as { id: string };
    const row = db.prepare('SELECT platform,credentials_encrypted FROM social_accounts WHERE id=?').get(params.id) as { platform: Platform; credentials_encrypted: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Аккаунт не найден' });
    try {
      return await testConnection(row.platform, decryptJson<Record<string, unknown>>(row.credentials_encrypted));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
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
    const project = db.prepare('SELECT default_timezone FROM projects WHERE id=?').get(projectId) as { default_timezone: string } | undefined;
    if (!project) return reply.code(400).send({ error: 'Проект не найден' });
    const title = String(body.title || '').trim();
    let content: { body: string; bodyRichJson: string };
    try { content = resolvedPostBody(body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    if (!title || !content.body.trim()) return reply.code(400).send({ error: 'Заголовок и текст обязательны' });
    const postId = id('post');
    const mode = ['MANUAL','AT','QUEUE'].includes(body.scheduleMode) ? body.scheduleMode : 'MANUAL';
    let schedule: ScheduleMutation;
    const scheduleInput = mode === 'AT' && body.scheduleTimezone === undefined
      ? { ...body, scheduleTimezone: project.default_timezone }
      : body;
    try { schedule = scheduleMutation(mode, scheduleInput); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    const created = db.transaction(() => {
      const now = nowIso();
      db.prepare('INSERT INTO posts (id,project_id,title,body,body_rich_json,status,schedule_mode,scheduled_at,scheduled_at_utc,schedule_timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(postId, projectId, title, content.body, content.bodyRichJson, 'DRAFT', mode, schedule.scheduledAt, schedule.scheduledAtUtc, schedule.scheduleTimezone, now, now);
      ensureTargets(postId);
      createInitialContentRevision(postId, 'manual');
      return db.prepare('SELECT * FROM posts WHERE id=?').get(postId);
    })();
    return reply.code(201).send(postView(created));
  });
  app.patch('/api/posts/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const body = bodyObject(request.body);
    const current = db.prepare('SELECT * FROM posts WHERE id=?').get(params.id) as any;
    if (!current) return reply.code(404).send({ error: 'Пост не найден' });
    if (IMMUTABLE_POST_STATUSES.has(current.status)) return reply.code(409).send({ error: 'Нельзя редактировать частично или полностью опубликованный пост' });
    const title = body.title === undefined ? current.title : String(body.title).trim();
    let content: { body: string; bodyRichJson: string };
    try { content = resolvedPostBody(body, current); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    const mode = body.scheduleMode === undefined ? current.schedule_mode : String(body.scheduleMode);
    if (!title || !content.body.trim()) return reply.code(400).send({ error: 'Заголовок и текст обязательны' });
    if (!['MANUAL','AT','QUEUE'].includes(mode)) return reply.code(400).send({ error: 'Неверный scheduleMode' });
    if (current.schedule_mode === 'QUEUE' && mode === 'AT' && body.confirmQueueToAt !== true) {
      return reply.code(409).send({ error: 'QUEUE_TO_AT_CONFIRMATION_REQUIRED', message: 'Convert QUEUE -> AT requires explicit confirmation' });
    }
    let schedule: ScheduleMutation;
    try { schedule = scheduleMutation(mode, body, current); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    try {
      const version = expectedContentVersion(request, body);
      const committed = commitContentEdit(params.id, version, 'manual', () => {
        db.prepare('UPDATE posts SET title=?,body=?,body_rich_json=?,schedule_mode=?,scheduled_at=?,scheduled_at_utc=?,schedule_timezone=?,updated_at=? WHERE id=?')
          .run(title, content.body, content.bodyRichJson, mode, schedule.scheduledAt, schedule.scheduledAtUtc, schedule.scheduleTimezone, nowIso(), params.id);
      });
      return { ok: true, contentVersion: committed.contentVersion, post: postView(db.prepare('SELECT * FROM posts WHERE id=?').get(params.id)) };
    } catch (error) {
      return contentMutationError(reply, error);
    }
  });

  app.put('/api/posts/:id/targets', async (request, reply) => {
    const params = request.params as { id: string };
    const post = db.prepare('SELECT status FROM posts WHERE id=?').get(params.id) as { status: string } | undefined;
    if (!post) return reply.code(404).send({ error: 'Пост не найден' });
    if (IMMUTABLE_POST_STATUSES.has(post.status)) return reply.code(409).send({ error: 'Нельзя менять площадки после начала публикации' });
    const body = bodyObject(request.body);
    if (!Array.isArray(body.accountIds) || body.accountIds.some((value: unknown) => typeof value !== 'string')) return reply.code(400).send({ error: 'accountIds должен быть массивом строк' });
    try {
      const version = expectedContentVersion(request, body);
      const committed = commitContentEdit(params.id, version, 'manual', () => setTargetSelection(params.id, body.accountIds as string[]));
      return { ok: true, contentVersion: committed.contentVersion, targets: (postView(db.prepare('SELECT * FROM posts WHERE id=?').get(params.id)) as any).targets };
    } catch (error) {
      return contentMutationError(reply, error);
    }
  });

  app.post('/api/posts/:id/media', async (request, reply) => {
    const params = request.params as { id: string };
    const post = db.prepare('SELECT status FROM posts WHERE id=?').get(params.id) as { status: string } | undefined;
    if (!post) return reply.code(404).send({ error: 'Пост не найден' });
    if (IMMUTABLE_POST_STATUSES.has(post.status)) return reply.code(409).send({ error: 'Нельзя менять медиа после начала публикации' });
    const part = await request.file({ limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
    if (!part) return reply.code(400).send({ error: 'Файл не передан' });
    if (!part.mimetype.startsWith('image/')) return reply.code(400).send({ error: 'Допускаются только изображения' });
    const buffer = await part.toBuffer();
    try {
      const version = expectedContentVersion(request);
      const saved = await saveImageVersioned(params.id, part.filename, buffer, version);
      return reply.code(201).send({ ...saved.media, contentVersion: saved.contentVersion });
    } catch (error) {
      return contentMutationError(reply, error);
    }
  });
  app.delete('/api/media/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const row = db.prepare('SELECT m.post_id,p.status FROM media m JOIN posts p ON p.id=m.post_id WHERE m.id=?').get(params.id) as { post_id: string; status: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Медиа не найдено' });
    if (IMMUTABLE_POST_STATUSES.has(row.status)) return reply.code(409).send({ error: 'Нельзя менять медиа после начала публикации' });
    try {
      const version = expectedContentVersion(request);
      const deleted = await deleteMediaVersioned(params.id, version);
      return { ok: true, contentVersion: deleted.contentVersion };
    } catch (error) {
      return contentMutationError(reply, error);
    }
  });

  app.post('/api/posts/:id/ready', async (request, reply) => {
    const params = request.params as { id: string };
    const post = db.prepare('SELECT * FROM posts WHERE id=?').get(params.id) as any;
    if (!post) return reply.code(404).send({ error: 'Пост не найден' });
    if (IMMUTABLE_POST_STATUSES.has(post.status)) return reply.code(409).send({ error: 'Пост уже начал публикацию; используйте повтор конкретной ошибочной площадки' });
    const mediaCount = db.prepare('SELECT COUNT(*) AS count FROM media WHERE post_id=?').get(params.id) as { count: number };
    if (mediaCount.count < 1) return reply.code(409).send({ error: 'Публикация без изображения запрещена' });
    ensureTargets(params.id);
    const accountCount = db.prepare("SELECT COUNT(*) AS count FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id WHERE pt.post_id=? AND pt.enabled=1 AND a.enabled=1").get(params.id) as { count: number };
    if (accountCount.count < 1) return reply.code(409).send({ error: 'Не выбрана ни одна активная соцсеть' });

    try {
      let body: Record<string, any> = {};
      if (request.body !== undefined && request.body !== null) body = bodyObject(request.body);
      const version = expectedContentVersion(request, body);
      const revision = snapshotContentRevision(params.id, version, 'manual');
      const preflight = preflightRevision(revision.id);
      if (!preflight.ok) {
        const details = preflight.issues.map((issue) => `${issue.platform} / ${issue.accountName}: ${issue.message}`).join('\n');
        event({ postId: params.id, level: 'warning', type: 'post_preflight_failed', message: 'Пост не прошёл проверку перед READY', data: { revisionId: revision.id, issues: preflight.issues } });
        return reply.code(409).send({ error: `Пост не готов к публикации:\n${details}`, issues: preflight.issues });
      }
      markReadyRevision(params.id, version, revision.id);
      event({ postId: params.id, type: 'post_ready', message: 'Пост готов к публикации', data: { revisionId: revision.id, contentVersion: version } });
      return { ok: true, contentVersion: version, revisionId: revision.id };
    } catch (error) {
      return contentMutationError(reply, error);
    }
  });
  app.post('/api/posts/:id/publish-now', async (request, reply) => {
    const params = request.params as { id: string };
    try { await publishPost(params.id); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
    return { ok: true, post: postView(db.prepare('SELECT * FROM posts WHERE id=?').get(params.id)) };
  });
  app.post('/api/targets/:id/retry', async (request, reply) => {
    const params = request.params as { id: string };
    try {
      await retryFailedTarget(params.id);
      return { ok: true };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post('/api/targets/:id/recovery/confirm-published', async (request, reply) => {
    const params = request.params as { id: string };
    let body: Record<string, any> = {};
    if (request.body !== undefined && request.body !== null) {
      try { body = bodyObject(request.body); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    }
    if (body.externalId !== undefined && body.externalId !== null && typeof body.externalId !== 'string') return reply.code(400).send({ error: 'externalId должен быть строкой или null' });
    if (body.externalUrl !== undefined && body.externalUrl !== null && typeof body.externalUrl !== 'string') return reply.code(400).send({ error: 'externalUrl должен быть строкой или null' });
    try {
      const result = confirmRecoveryPublished(params.id, body.externalId ?? null, body.externalUrl ?? null);
      return { ok: true, postId: result.postId };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post('/api/targets/:id/recovery/confirm-not-published', async (request, reply) => {
    const params = request.params as { id: string };
    try {
      const result = confirmRecoveryNotPublished(params.id);
      return { ok: true, postId: result.postId };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
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

    const duplicate = db.prepare(`SELECT id FROM schedule_slots
      WHERE project_id=? AND weekday=? AND time_hhmm=? AND timezone=?`).get(projectId, weekday, time, timezone);
    if (duplicate) return reply.code(409).send({ error: 'Такой слот расписания уже существует' });

    const slotId = id('slot');
    try {
      db.prepare('INSERT INTO schedule_slots (id,project_id,weekday,time_hhmm,timezone,enabled,created_at) VALUES (?,?,?,?,?,1,?)')
        .run(slotId, projectId, weekday, time, timezone, nowIso());
    } catch (error) {
      if (error instanceof Error && error.message.includes('uq_schedule_slots_project_weekday_time_timezone')) {
        return reply.code(409).send({ error: 'Такой слот расписания уже существует' });
      }
      throw error;
    }
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
}
