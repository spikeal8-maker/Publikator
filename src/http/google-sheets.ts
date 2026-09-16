import type { FastifyInstance } from 'fastify';
import {
  createGoogleSheetsConnector,
  inspectGoogleSpreadsheet,
  listGoogleSheetsConnectors,
  testGoogleSheetsConnector,
  updateGoogleSheetsPolling
} from '../google-sheets.js';
import {
  applyGoogleSheetsCloudMedia,
  previewGoogleSheetsCloudMedia
} from '../google-sheets-cloud-media.js';
import { beginExclusiveRuntimeMaintenance } from '../runtime-gate.js';
import { googleSheetsPollingStatus } from '../google-sheets-polling.js';

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, unknown>;
}

export async function registerGoogleSheetsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/google-sheets/connectors', async () => ({
    connectors: listGoogleSheetsConnectors().map((connector) => ({ ...connector, polling: googleSheetsPollingStatus(connector) }))
  }));

  app.post('/api/google-sheets/inspect', async (request, reply) => {
    try {
      const body = bodyObject(request.body);
      return await inspectGoogleSpreadsheet(body.credentials, body.spreadsheetId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/google-sheets/connectors', async (request, reply) => {
    try {
      const body = bodyObject(request.body);
      const connector = await createGoogleSheetsConnector({
        name: String(body.name ?? ''),
        spreadsheetId: body.spreadsheetId,
        sheetName: body.sheetName,
        writeBack: body.writeBack === true,
        pollingEnabled: body.pollingEnabled === true,
        pollIntervalMinutes: body.pollIntervalMinutes ?? 15,
        autoApplyEnabled: body.autoApplyEnabled === true,
        credentials: body.credentials
      });
      return reply.code(201).send({ connector });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/api/google-sheets/connectors/:id/polling', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      const body = bodyObject(request.body);
      if (typeof body.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be boolean' });
      const connector = updateGoogleSheetsPolling(params.id, { enabled: body.enabled, intervalMinutes: body.intervalMinutes, autoApplyEnabled: Object.prototype.hasOwnProperty.call(body, 'autoApplyEnabled') ? body.autoApplyEnabled === true : undefined });
      return { connector, polling: googleSheetsPollingStatus(connector) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/google-sheets/connectors/:id/test', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      return await testGoogleSheetsConnector(params.id);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/google-sheets/connectors/:id/preview', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      return await previewGoogleSheetsCloudMedia(params.id);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/google-sheets/connectors/:id/apply', async (request, reply) => {
    let release: (() => void) | null = null;
    try {
      const params = request.params as { id: string };
      const body = bodyObject(request.body);
      if (body.confirm !== 'IMPORT') return reply.code(400).send({ error: 'Нужно явное confirm=IMPORT' });
      const previewSha = String(body.previewSha ?? '').trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(previewSha)) return reply.code(400).send({ error: 'Нужен SHA-256 из Google Sheets preview' });
      const mediaPreviewSha = body.mediaPreviewSha == null ? null : String(body.mediaPreviewSha).trim().toLowerCase();
      if (mediaPreviewSha && !/^[a-f0-9]{64}$/.test(mediaPreviewSha)) return reply.code(400).send({ error: 'Некорректный SHA-256 cloud media preview' });
      release = beginExclusiveRuntimeMaintenance('google-sheets import');
      return { ok: true, ...(await applyGoogleSheetsCloudMedia(params.id, previewSha, mediaPreviewSha)) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      release?.();
    }
  });
}
