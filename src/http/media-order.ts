import type { FastifyInstance } from 'fastify';
import { db, event } from '../db.js';
import { reorderMedia } from '../media.js';
import { commitContentEdit } from '../content-versioning.js';
import { contentMutationError, expectedContentVersion } from './content-version.js';

const IMMUTABLE_POST_STATUSES = new Set(['PUBLISHING', 'PARTIAL', 'PUBLISHED']);

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, unknown>;
}

export async function registerMediaOrderRoutes(app: FastifyInstance): Promise<void> {
  app.put('/api/posts/:postId/media-order', async (request, reply) => {
    const params = request.params as { postId: string };
    const post = db.prepare('SELECT status FROM posts WHERE id=?').get(params.postId) as { status: string } | undefined;
    if (!post) return reply.code(404).send({ error: 'Пост не найден' });
    if (IMMUTABLE_POST_STATUSES.has(post.status)) {
      return reply.code(409).send({ error: 'Нельзя менять порядок изображений после начала публикации' });
    }

    let body: Record<string, unknown>;
    try {
      body = bodyObject(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    if (!Array.isArray(body.mediaIds) || body.mediaIds.some((value) => typeof value !== 'string')) {
      return reply.code(400).send({ error: 'mediaIds должен быть массивом строк' });
    }

    try {
      const version = expectedContentVersion(request, body);
      const committed = commitContentEdit(params.postId, version, () => reorderMedia(params.postId, body.mediaIds as string[]));
      event({ postId: params.postId, type: 'media_reordered', message: 'Порядок изображений изменён', data: { mediaIds: body.mediaIds, contentVersion: committed.contentVersion } });
      return { ok: true, contentVersion: committed.contentVersion, media: committed.value };
    } catch (error) {
      return contentMutationError(reply, error);
    }
  });
}
