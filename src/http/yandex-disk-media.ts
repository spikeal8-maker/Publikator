import type { FastifyInstance } from 'fastify';
import {
  createYandexDiskMediaConnector,
  inspectYandexDiskMedia,
  listYandexDiskMediaConnectors,
  testYandexDiskMediaConnector
} from '../yandex-disk-media.js';

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, unknown>;
}

export async function registerYandexDiskMediaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/yandex-disk/connectors', async () => ({ connectors: listYandexDiskMediaConnectors() }));

  app.post('/api/yandex-disk/inspect', async (request, reply) => {
    try {
      const body = bodyObject(request.body);
      return await inspectYandexDiskMedia(body.credentials, body.rootPath);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post('/api/yandex-disk/connectors', async (request, reply) => {
    try {
      const body = bodyObject(request.body);
      const connector = await createYandexDiskMediaConnector({
        name: String(body.name ?? ''),
        rootPath: body.rootPath,
        credentials: body.credentials
      });
      return reply.code(201).send({ connector });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/yandex-disk/connectors/:id/test', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      return await testYandexDiskMediaConnector(params.id);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
