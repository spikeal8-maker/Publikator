import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { beginRuntimeActivity } from '../runtime-gate.js';
import { AgentRegistryError } from '../agent-registry-error.js';
import type { VerifiedAgentIdentity } from '../agent-grant-acl.js';
import { CHATGPT_MCP_PATH, CHATGPT_RESOURCE_METADATA, type registerChatGPTIssuer } from './agent-oauth.js';
import { listVerifiedAccounts } from './agent-accounts.js';
import { parsePage } from './agent-page.js';
import { listVerifiedProjects } from './agent-projects.js';
import { updateScopedAgentDraft } from './agent-draft-edits.js';
import { listOwnDrafts, getOwnDraft, parseOwnedPage } from './agent-owned-drafts.js';
import { createScopedAgentDraft } from './agent-text-drafts.js';
import { getScopedPublication, getScopedPublicationAnalytics, listScopedPublications } from './agent-publication-read.js';

type Issuer = NonNullable<Awaited<ReturnType<typeof registerChatGPTIssuer>>>;
type Scope = 'projects:read' | 'accounts:read' | 'posts:read' | 'posts:write';

const page = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(512).optional(),
}).strict();
const identifier = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const draft = z.object({
  projectId: identifier,
  targetAccountIds: z.array(identifier).min(1).max(20),
  internalTitle: z.string().min(1).max(160),
  bodyPlain: z.string().min(1).max(20000),
  idempotencyKey: identifier,
}).strict();

function pageQuery(input: z.infer<typeof page>) {
  return {
    ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  };
}

export async function registerChatGPTMcp(app: FastifyInstance, issuer: Issuer | null) {
  if (!issuer) return;

  const url = new URL(issuer.resource);
  const metadata = new URL(CHATGPT_RESOURCE_METADATA, url).href;
  const challenge = (error: 'invalid_token' | 'insufficient_scope', scope?: Scope) =>
    `Bearer resource_metadata="${metadata}", error="${error}", error_description="Publikator authorization required"` +
    (scope ? `, scope="${scope}"` : '');

  app.post(CHATGPT_MCP_PATH, { bodyLimit: 64 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (request.headers.host !== url.host
      || request.protocol !== url.protocol.slice(0, -1)
      || (request.headers.origin !== undefined && request.headers.origin !== url.origin)) {
      return reply.code(403).send({ error: 'invalid_origin' });
    }
    const authorization = request.headers.authorization;
    const bearer = typeof authorization === 'string'
      ? /^Bearer ([A-Za-z0-9_-]{20,512})$/i.exec(authorization)?.[1] : undefined;
    if (!bearer || request.headers.cookie !== undefined
      || request.headers['x-api-key'] !== undefined || request.headers['x-integration-key'] !== undefined
      || !await issuer.authenticate(bearer)) {
      return reply.header('www-authenticate', challenge('invalid_token')).code(401).send({ error: 'invalid_token' });
    }

    function toolError(message: string, authenticate?: string) {
      return {
        content: [{ type: 'text' as const, text: message }],
        isError: true,
        ...(authenticate ? { _meta: { 'mcp/www_authenticate': [authenticate] } } : {}),
      };
    }

    async function invoke(scope: Scope, operation: (identity: VerifiedAgentIdentity) => object) {
      try {
        const current = await issuer!.authenticate(bearer!);
        if (!current) return toolError('Подключение истекло или было отозвано.', challenge('invalid_token'));
        if (!current.scopeIds.includes(scope)) {
          return toolError('Эта операция не входит в разрешения подключения.', challenge('insufficient_scope', scope));
        }
        let release: () => void;
        try {
          release = beginRuntimeActivity();
        } catch {
          return toolError('Publikator временно недоступен. Повторите после обслуживания.');
        }
        try {
          const value = operation({ ...current, tokenScopes: current.scopeIds });
          return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
        } finally {
          release();
        }
      } catch (error) {
        return toolError(error instanceof AgentRegistryError ? error.message : 'Операция не выполнена.');
      }
    }

    function policy(scope: Scope, readOnly: boolean) {
      return {
        _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] },
        annotations: {
          readOnlyHint: readOnly, destructiveHint: false,
          idempotentHint: true, openWorldHint: false,
        },
      };
    }

    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'publikator-chatgpt', version: '1.0.0' });
      server.registerTool('publikator_list_projects', {
        description: 'Показать проекты Publikator, доступные этому подключению. Используйте ID из результата при подготовке черновика.',
        inputSchema: page,
        ...policy('projects:read', true),
      }, async (args) => invoke('projects:read', (identity) => listVerifiedProjects(() => identity, parsePage(pageQuery(args)))));
      server.registerTool('publikator_list_accounts', {
        description: 'Показать разрешённые аккаунты, площадки и подтверждённые возможности публикации.',
        inputSchema: page,
        ...policy('accounts:read', true),
      }, async (args) => invoke('accounts:read', (identity) => listVerifiedAccounts(() => identity, parsePage(pageQuery(args)))));
      server.registerTool('publikator_create_text_draft', {
        description: 'Сохранить текстовый черновик в выбранном проекте с явно выбранными получателями. Повтор того же запроса с тем же ключом возвращает исходный черновик.',
        inputSchema: draft,
        ...policy('posts:write', false),
      }, async ({ idempotencyKey, ...args }) => invoke('posts:write', (identity) =>
        createScopedAgentDraft(() => identity, {
          ...args, contentFormat: 'TEXT_ONLY', publicationKind: 'FEED', mediaAssetIds: [],
        }, idempotencyKey, 'MCP').data));
      server.registerTool('publikator_list_text_drafts', {
        description: 'Показать текстовые черновики, ранее созданные через это подключение. Используйте postId и текущую версию для редактирования.',
        inputSchema: page,
        ...policy('posts:read', true),
      }, async (args) => invoke('posts:read', (identity) => listOwnDrafts(() => identity, parseOwnedPage(pageQuery(args)))));
      server.registerTool('publikator_get_text_draft', {
        description: 'Прочитать текст, получателей и текущую версию своего черновика.',
        inputSchema: z.object({ postId: identifier }).strict(),
        ...policy('posts:read', true),
      }, async ({ postId }) => invoke('posts:read', (identity) => getOwnDraft(() => identity, postId)));
      server.registerTool('publikator_edit_text_draft', {
        description: 'Исправить текст или название ранее созданного черновика. Укажите текущую версию и новый ключ операции. Получатели и срок публикации сохраняются.',
        inputSchema: z.object({
          postId: identifier, expectedContentVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          internalTitle: z.string().min(1).max(160).optional(),
          bodyPlain: z.string().min(1).max(20000).optional(),
          idempotencyKey: identifier,
        }).strict(),
        ...policy('posts:write', false),
      }, async ({ postId, idempotencyKey, ...patch }) => invoke('posts:write', (identity) =>
        updateScopedAgentDraft(() => identity, postId, patch, idempotencyKey, 'MCP').data));
      server.registerTool('publikator_list_publications', {
        description: 'Показать редакционные материалы разрешённого проекта, включая статусы и расписание. Для полного текста используйте publikator_get_publication.',
        inputSchema: page.extend({ projectId: identifier }),
        ...policy('posts:read', true),
      }, async ({ projectId, ...pagination }) => invoke('posts:read', (identity) =>
        listScopedPublications(identity, projectId, parsePage(pageQuery(pagination)))));
      server.registerTool('publikator_get_publication', {
        description: 'Прочитать текст, статус, расписание, состав медиа и состояние отправки разрешённой публикации. Используйте текст для редакционного анализа.',
        inputSchema: z.object({ projectId: identifier, postId: identifier }).strict(),
        ...policy('posts:read', true),
      }, async ({ projectId, postId }) => invoke('posts:read', (identity) =>
        getScopedPublication(identity, projectId, postId)));
      server.registerTool('publikator_get_publication_analytics', {
        description: 'Посчитать доступные публикации по редакционному статусу и расписанию, доставки по площадке и результату. Возвращает данные Publikator о доставке.',
        inputSchema: z.object({ projectId: identifier }).strict(),
        ...policy('posts:read', true),
      }, async ({ projectId }) => invoke('posts:read', (identity) =>
        getScopedPublicationAnalytics(identity, projectId)));
      return server;
    }, { legacy: 'stateless', maxRequestBodySize: 64 * 1024 });

    const headers = new Headers();
    for (const name of ['content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'last-event-id']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const response = await handler.fetch(new Request(url, {
      method: 'POST', headers, body: JSON.stringify(request.body),
    }), { parsedBody: request.body });
    response.headers.forEach((value, key) => {
      if (!['content-length', 'connection', 'transfer-encoding'].includes(key)) reply.header(key, value);
    });
    reply.code(response.status);
    return reply.send(response.body ? Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]) : undefined);
  });
}
