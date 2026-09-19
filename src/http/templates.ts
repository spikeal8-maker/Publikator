import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  TemplateNotFoundError,
  TemplateValidationError,
  createPostFromTemplate,
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate
} from '../templates.js';

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TemplateValidationError('Ожидается JSON-объект');
  }
  return body as Record<string, unknown>;
}

function templateError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TemplateNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof TemplateValidationError) return reply.code(400).send({ error: error.message });
  return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
}

export async function registerTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/templates', async () => listTemplates());

  app.post('/api/templates', async (request, reply) => {
    try {
      return reply.code(201).send(createTemplate(bodyObject(request.body)));
    } catch (error) {
      return templateError(reply, error);
    }
  });

  app.patch('/api/templates/:id', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      return updateTemplate(params.id, bodyObject(request.body));
    } catch (error) {
      return templateError(reply, error);
    }
  });

  app.delete('/api/templates/:id', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      deleteTemplate(params.id);
      return reply.code(204).send();
    } catch (error) {
      return templateError(reply, error);
    }
  });
  app.post('/api/templates/:id/create-post', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      return reply.code(201).send(createPostFromTemplate(params.id));
    } catch (error) {
      return templateError(reply, error);
    }
  });
}
