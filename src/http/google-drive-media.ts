import type { FastifyInstance } from 'fastify';
import {
  createGoogleDriveMediaConnector,
  inspectGoogleDriveMedia,
  listGoogleDriveMediaConnectors,
  testGoogleDriveMediaConnector
} from '../google-drive-media.js';

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, unknown>;
}

export async function registerGoogleDriveMediaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/google-drive/connectors', async () => ({ connectors: listGoogleDriveMediaConnectors() }));

  app.post('/api/google-drive/inspect', async (request, reply) => {
    try {
      const body = bodyObject(request.body);
      return await inspectGoogleDriveMedia(body.credentials, body.rootFolder);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/google-drive/connectors', async (request, reply) => {
    try {
      const body = bodyObject(request.body);
      const connector = await createGoogleDriveMediaConnector({
        name: String(body.name ?? ''),
        rootFolder: body.rootFolder,
        credentials: body.credentials
      });
      return reply.code(201).send({ connector });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/google-drive/connectors/:id/test', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      return await testGoogleDriveMediaConnector(params.id);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
