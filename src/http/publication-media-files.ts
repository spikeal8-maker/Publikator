import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sessionAdmin } from '../admin-auth.js';
import { config } from '../config.js';
import { db } from '../db.js';

export async function registerPublicationMediaFiles(app: FastifyInstance): Promise<void> {
  const agentDraft = db.prepare(`SELECT 1 FROM posts p WHERE p.id = ?
    AND (p.source_type='agent-api' OR EXISTS (
      SELECT 1 FROM agent_draft_ownership ownership WHERE ownership.post_id=p.id
    ))`);
  await app.register(async (media) => {
    const privateRequests = new WeakSet<FastifyRequest>();
    media.addHook('onSend', async (request, reply) => {
      if (privateRequests.has(request)) reply.header('Cache-Control', 'private, no-store');
    });

    await media.register(fastifyStatic, {
      root: config.mediaDir,
      prefix: '/public-media/',
      decorateReply: false,
      index: false,
      allowedPath(pathName, _root, request) {
        // The canonical asset writer uses the post ID as the top-level directory.
        // This protects images and posters even while an attachment is being saved.
        const postId = pathName.replace(/^\//, '').split('/', 1)[0];
        if (!postId || !agentDraft.get(postId)) return true;
        privateRequests.add(request);
        return Boolean(sessionAdmin(request.cookies.publikator_session));
      },
    });
  });
}
