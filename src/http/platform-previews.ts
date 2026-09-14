import type { FastifyInstance } from 'fastify';
import { platformPreviews } from '../platform-preview.js';

export async function registerPlatformPreviewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/posts/:id/platform-previews', async (request, reply) => {
    const params = request.params as { id: string };
    try {
      return { postId: params.id, previews: platformPreviews(params.id) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Пост не найден') return reply.code(404).send({ error: message });
      return reply.code(400).send({ error: message });
    }
  });
}
