import type { FastifyInstance } from 'fastify';
import { db, nowIso } from '../db.js';
import { commitContentEdit } from '../content-versioning.js';
import { contentMutationError, expectedContentVersion } from './content-version.js';

const IMMUTABLE_POST_STATUSES = new Set(['PUBLISHING', 'PUBLISHED', 'PARTIAL']);
const MAX_OVERRIDE_LENGTH = 20_000;

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, unknown>;
}

export async function registerTargetOverrideRoutes(app: FastifyInstance): Promise<void> {
  app.patch('/api/posts/:postId/targets/:targetId/text', async (request, reply) => {
    const params = request.params as { postId: string; targetId: string };
    const row = db.prepare(`SELECT pt.id, pt.post_id, pt.account_id, pt.override_text, pt.state,
      p.status AS post_status, p.body AS base_text, a.platform, a.name AS account_name
      FROM post_targets pt
      JOIN posts p ON p.id=pt.post_id
      JOIN social_accounts a ON a.id=pt.account_id
      WHERE pt.id=? AND pt.post_id=?`).get(params.targetId, params.postId) as any;

    if (!row) return reply.code(404).send({ error: 'Цель публикации не найдена' });
    if (IMMUTABLE_POST_STATUSES.has(row.post_status)) {
      return reply.code(409).send({ error: 'Нельзя менять текст площадки после начала публикации' });
    }
    if (row.state === 'PUBLISHED') {
      return reply.code(409).send({ error: 'Эта публикация на площадке уже выполнена' });
    }

    let body: Record<string, unknown>;
    try {
      body = bodyObject(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    if (!Object.prototype.hasOwnProperty.call(body, 'text')) {
      return reply.code(400).send({ error: 'Поле text обязательно; null или пустая строка сбрасывает отдельный текст площадки' });
    }
    if (body.text !== null && typeof body.text !== 'string') {
      return reply.code(400).send({ error: 'text должен быть строкой или null' });
    }

    const normalized = typeof body.text === 'string' ? body.text.trim() : '';
    if (normalized.length > MAX_OVERRIDE_LENGTH) {
      return reply.code(400).send({ error: `Отдельный текст площадки не должен превышать ${MAX_OVERRIDE_LENGTH} символов` });
    }
    const overrideText = normalized.length > 0 ? normalized : null;
    const now = nowIso();

    let nextVersion: number;
    try {
      const version = expectedContentVersion(request, body);
      const committed = commitContentEdit(params.postId, version, () => {
        db.prepare('UPDATE post_targets SET override_text=?, updated_at=? WHERE id=?')
          .run(overrideText, now, params.targetId);
      });
      nextVersion = committed.contentVersion;
    } catch (error) {
      return contentMutationError(reply, error);
    }

    return {
      ok: true,
      contentVersion: nextVersion,
      target: {
        id: row.id,
        accountId: row.account_id,
        accountName: row.account_name,
        platform: row.platform,
        overrideText,
        resolvedText: overrideText ?? row.base_text
      }
    };
  });
}
