import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { listMedia } from '../media.js';
import {
  archivePost,
  deletePostPermanently,
  editorialActions,
  restorePost,
  trashPost,
  type EditorialStage
} from '../editorial-lifecycle.js';
import { contentMutationError, expectedContentVersion } from './content-version.js';

type EditorialListView = 'active' | 'archive' | 'trash';

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается JSON-объект');
  return body as Record<string, unknown>;
}

function listCondition(view: EditorialListView): string {
  if (view === 'archive') return "p.editorial_stage='ARCHIVED'";
  if (view === 'trash') return "p.editorial_stage='TRASHED'";
  return "p.editorial_stage NOT IN ('ARCHIVED','TRASHED')";
}

function listPosts(view: EditorialListView): unknown[] {
  return db.prepare(`SELECT p.*, pr.name AS project_name,
      (SELECT COUNT(*) FROM media m WHERE m.post_id=p.id) AS media_count
    FROM posts p JOIN projects pr ON pr.id=p.project_id
    WHERE ${listCondition(view)}
    ORDER BY p.updated_at DESC,p.created_at DESC`).all();
}

function inspector(postId: string): any | undefined {
  const post = db.prepare(`SELECT p.*,pr.name AS project_name
    FROM posts p JOIN projects pr ON pr.id=p.project_id WHERE p.id=?`).get(postId) as any;
  if (!post) return undefined;
  const targets = db.prepare(`SELECT pt.id,pt.account_id,pt.enabled,pt.override_text,pt.state,pt.attempts,
      pt.external_id,pt.external_url,pt.last_error,pt.published_at,a.platform,a.name AS account_name
    FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.post_id=? ORDER BY a.platform,a.name`).all(postId);
  const events = db.prepare(`SELECT id,level,event_type,message,data_json,created_at
    FROM publication_events WHERE post_id=? ORDER BY created_at DESC LIMIT 20`).all(postId);
  return {
    ...post,
    media: listMedia(postId),
    targets,
    recentEvents: events,
    actions: editorialActions({ status: post.status, editorial_stage: post.editorial_stage as EditorialStage })
  };
}

export async function registerEditorialLifecycleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/editorial/posts', async (request, reply) => {
    const query = request.query as { view?: string };
    const view = (query.view || 'active') as EditorialListView;
    if (!['active', 'archive', 'trash'].includes(view)) return reply.code(400).send({ error: 'view должен быть active, archive или trash' });
    return listPosts(view);
  });

  app.get('/api/editorial/posts/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const value = inspector(params.id);
    if (!value) return reply.code(404).send({ error: 'Пост не найден' });
    return value;
  });

  app.post('/api/posts/:id/archive', async (request, reply) => {
    const params = request.params as { id: string };
    try {
      const body = bodyObject(request.body);
      const result = archivePost(params.id, expectedContentVersion(request, body));
      return { ok: true, ...result, post: inspector(params.id) };
    } catch (error) {
      return contentMutationError(reply, error);
    }
  });

  app.post('/api/posts/:id/trash', async (request, reply) => {
    const params = request.params as { id: string };
    try {
      const body = bodyObject(request.body);
      const result = trashPost(params.id, expectedContentVersion(request, body));
      return { ok: true, ...result, post: inspector(params.id) };
    } catch (error) {
      return contentMutationError(reply, error);
    }
  });

  app.post('/api/posts/:id/restore', async (request, reply) => {
    const params = request.params as { id: string };
    try {
      const body = bodyObject(request.body);
      const result = restorePost(params.id, expectedContentVersion(request, body));
      return { ok: true, ...result, post: inspector(params.id) };
    } catch (error) {
      return contentMutationError(reply, error);
    }
  });

  app.delete('/api/posts/:id/permanent', async (request, reply) => {
    const params = request.params as { id: string };
    try {
      const body = bodyObject(request.body);
      if (body.confirm !== true) return reply.code(400).send({ error: 'Permanent delete требует явного confirm=true' });
      const result = await deletePostPermanently(params.id, expectedContentVersion(request, body));
      return { ok: true, ...result };
    } catch (error) {
      return contentMutationError(reply, error);
    }
  });
}
