import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db } from '../db.js';
import { saveVideoVersioned } from '../media.js';
import { contentMutationError, expectedContentVersion } from './content-version.js';

const IMMUTABLE_POST_STATUSES = new Set(['PUBLISHING', 'PUBLISHED', 'PARTIAL']);

export async function registerVideoMediaRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/posts/:id/video', async (request, reply) => {
    const params = request.params as { id: string };
    const post = db.prepare('SELECT status FROM posts WHERE id=?').get(params.id) as { status: string } | undefined;
    if (!post) return reply.code(404).send({ error: 'Пост не найден' });
    if (IMMUTABLE_POST_STATUSES.has(post.status)) {
      return reply.code(409).send({ error: 'Нельзя менять медиа после начала публикации' });
    }

    let part;
    try {
      part = await request.file({ limits: { fileSize: config.maxVideoBytes, files: 1 } });
    } catch (error) {
      return reply.code(413).send({ error: `Видео превышает допустимый multipart limit: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (!part) return reply.code(400).send({ error: 'Файл не передан' });
    if (part.mimetype !== 'video/mp4') {
      part.file.resume();
      return reply.code(400).send({ error: 'Video v1 принимает только MIME video/mp4' });
    }

    try {
      const version = expectedContentVersion(request);
      const saved = await saveVideoVersioned(params.id, part.filename, part.file, version);
      return reply.code(201).send({
        ...saved.media,
        poster: saved.poster,
        contentVersion: saved.contentVersion
      });
    } catch (error) {
      return contentMutationError(reply, error);
    }
  });
}
