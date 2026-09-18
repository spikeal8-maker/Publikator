import type { FastifyInstance, FastifyReply } from 'fastify';
import { ContentConflictError } from '../content-versioning.js';
import {
  RevisionHistoryNotFoundError,
  RevisionRestoreBlockedError,
  getRevisionDetail,
  getRevisionDiff,
  listPostRevisions,
  restoreRevision
} from '../revision-history.js';
import { expectedContentVersion } from './content-version.js';

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, unknown>;
}

function revisionError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof RevisionHistoryNotFoundError) {
    return reply.code(404).send({ code: 'REVISION_NOT_FOUND', error: error.message });
  }
  if (error instanceof ContentConflictError) {
    return reply.code(409).send({ code: 'REVISION_CONFLICT', error: 'Материал уже изменён. Обновите историю и повторите.' });
  }
  if (error instanceof RevisionRestoreBlockedError) {
    return reply.code(409).send({ code: error.code, error: error.message });
  }
  return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
}

export async function registerRevisionHistoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/posts/:id/revisions', async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as { limit?: string; beforeVersion?: string };
    try {
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      const beforeVersion = query.beforeVersion === undefined ? undefined : Number(query.beforeVersion);
      return listPostRevisions(params.id, { limit, beforeVersion });
    } catch (error) {
      return revisionError(reply, error);
    }
  });

  app.get('/api/posts/:id/revisions/:revisionId', async (request, reply) => {
    const params = request.params as { id: string; revisionId: string };
    try {
      return getRevisionDetail(params.id, params.revisionId);
    } catch (error) {
      return revisionError(reply, error);
    }
  });

  app.get('/api/posts/:id/revisions/:revisionId/diff', async (request, reply) => {
    const params = request.params as { id: string; revisionId: string };
    try {
      return await getRevisionDiff(params.id, params.revisionId);
    } catch (error) {
      return revisionError(reply, error);
    }
  });

  app.post('/api/posts/:id/revisions/:revisionId/restore', async (request, reply) => {
    const params = request.params as { id: string; revisionId: string };
    try {
      const body = bodyObject(request.body);
      const result = await restoreRevision(
        params.id,
        params.revisionId,
        expectedContentVersion(request, body)
      );
      return { ok: true, ...result };
    } catch (error) {
      return revisionError(reply, error);
    }
  });
}
