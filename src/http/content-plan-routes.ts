import type { FastifyInstance } from 'fastify';
import { importCsvPosts } from '../content-import.js';
import { db, nowIso } from '../db.js';
import { setTargetSelection, type TargetSelection } from '../publisher.js';

const IMMUTABLE_POST_STATUSES = new Set(['PUBLISHING', 'PUBLISHED', 'PARTIAL']);

function bodyObject(body: unknown): Record<string, any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, any>;
}

export async function registerContentPlanRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/content/import-template', async () => ({
    filename: 'publikator-content-template.csv',
    csv: 'title,body,schedule_mode,scheduled_at,platforms,telegram_text,vk_text,max_text,instagram_text\n"Пример поста","Основной текст",QUEUE,,"telegram;vk","Текст для Telegram","Текст для VK",,\n'
  }));

  app.post('/api/content/import-csv', async (request, reply) => {
    let body: Record<string, any>;
    try {
      body = bodyObject(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const projectId = String(body.projectId || '');
    const csv = typeof body.csv === 'string' ? body.csv : '';
    try {
      const result = importCsvPosts(projectId, csv);
      return reply.code(result.created > 0 ? 201 : 400).send(result);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/api/content/posts/:id/targets', async (request, reply) => {
    const params = request.params as { id: string };
    const post = db.prepare('SELECT status FROM posts WHERE id=?').get(params.id) as { status: string } | undefined;
    if (!post) return reply.code(404).send({ error: 'Пост не найден' });
    if (IMMUTABLE_POST_STATUSES.has(post.status)) {
      return reply.code(409).send({ error: 'Нельзя менять площадки или их тексты после начала публикации' });
    }

    let body: Record<string, any>;
    try {
      body = bodyObject(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    if (!Array.isArray(body.targets)) return reply.code(400).send({ error: 'targets должен быть массивом' });

    const selections: TargetSelection[] = [];
    for (const value of body.targets as unknown[]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return reply.code(400).send({ error: 'Некорректная цель публикации' });
      const target = value as Record<string, unknown>;
      if (typeof target.accountId !== 'string' || !target.accountId.trim()) return reply.code(400).send({ error: 'Для каждой цели нужен accountId' });
      if (target.overrideText !== undefined && target.overrideText !== null && typeof target.overrideText !== 'string') {
        return reply.code(400).send({ error: 'overrideText должен быть строкой' });
      }
      selections.push({ accountId: target.accountId, overrideText: typeof target.overrideText === 'string' ? target.overrideText : null });
    }

    setTargetSelection(params.id, selections);
    db.prepare("UPDATE posts SET status='DRAFT',updated_at=? WHERE id=?").run(nowIso(), params.id);
    return { ok: true };
  });
}
