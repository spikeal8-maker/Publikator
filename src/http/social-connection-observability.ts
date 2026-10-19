import type { FastifyInstance } from 'fastify';
import { db, event, id } from '../db.js';

type Operation = 'inspect' | 'check' | 'save' | 'recheck' | 'activate' | 'update';
type TrackedOperation = { route: string; operation: Operation };

const SOCIAL_PLATFORMS = new Set(['telegram', 'max', 'vk', 'instagram']);
const PRIVATE_FIELDS = new Set([
  'accessToken', 'botToken', 'uploadAccessToken', 'clientSecret', 'password',
  'apiKey', 'refreshToken', 'authorization', 'token', 'access_token', 'client_secret'
]);

function operationFor(method: string, path: string): TrackedOperation | null {
  if (method === 'POST' && path === '/api/vk/token/inspect') return { route: 'vk.token.inspect', operation: 'inspect' };
  if (method === 'POST' && path === '/api/accounts/test') return { route: 'accounts.test', operation: 'check' };
  if (method === 'POST' && path === '/api/accounts/save-and-check') return { route: 'accounts.save-and-check', operation: 'save' };
  if (method === 'POST' && path === '/api/accounts') return { route: 'accounts.create', operation: 'save' };
  if (method === 'PATCH' && /^\/api\/accounts\/[^/]+$/.test(path)) return { route: 'accounts.update', operation: 'update' };
  if (method === 'POST' && /^\/api\/accounts\/[^/]+\/recheck$/.test(path)) return { route: 'accounts.recheck', operation: 'recheck' };
  if (method === 'POST' && /^\/api\/accounts\/[^/]+\/test$/.test(path)) return { route: 'accounts.saved-test', operation: 'check' };
  if (method === 'POST' && /^\/api\/accounts\/[^/]+\/activate$/.test(path)) return { route: 'accounts.activate', operation: 'activate' };
  if (method === 'POST' && /^\/api\/accounts\/[^/]+\/vk-community\/test$/.test(path)) return { route: 'accounts.vk-community.test', operation: 'check' };
  if (method === 'POST' && /^\/api\/accounts\/[^/]+\/vk-community$/.test(path)) return { route: 'accounts.vk-community.create', operation: 'save' };
  return null;
}

function knownPlatform(value: unknown): string | null {
  return typeof value === 'string' && SOCIAL_PLATFORMS.has(value.toLowerCase()) ? value.toLowerCase() : null;
}

function platformFromRequest(body: unknown, params: unknown): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const direct = knownPlatform((body as Record<string, unknown>).platform);
    if (direct) return direct;
  }
  const accountId = params && typeof params === 'object'
    ? (params as Record<string, unknown>).id : undefined;
  if (typeof accountId !== 'string' || accountId.length > 150) return 'unknown';
  try {
    const account = db.prepare('SELECT platform FROM social_accounts WHERE id=?')
      .get(accountId) as { platform: string } | undefined;
    return knownPlatform(account?.platform) || 'unknown';
  } catch {
    return 'unknown';
  }
}

function privateValues(body: unknown): string[] {
  const values = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || !value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      if (PRIVATE_FIELDS.has(key)) {
        if (typeof field === 'string' && field.length > 0) values.add(field);
      } else {
        visit(field, depth + 1);
      }
    }
  };
  visit(body, 0);
  return [...values].sort((a, b) => b.length - a.length);
}

function safeProviderMessage(message: unknown, body: unknown): string {
  let safe = typeof message === 'string' ? message : 'Проверка подключения завершилась ошибкой.';
  for (const secret of privateValues(body)) {
    safe = safe.replaceAll(secret, '[скрыто]');
    try {
      safe = safe.replaceAll(encodeURIComponent(secret), '[скрыто]');
    } catch {
      // Malformed input must not affect the diagnostic response.
    }
  }
  safe = safe
    .replace(/\/bot\d{4,}:[A-Za-z0-9_-]+/gi, '/bot[скрыто]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{10,}\b/g, '[скрыто]')
    .replace(/\bvk1\.[A-Za-z0-9_.-]{15,}/gi, '[скрыто]')
    .replace(/([?&](?:access_token|bot_token|client_secret|token|api_key)=)[^&#\s]+/gi, '$1[скрыто]')
    .replace(/((?:access[_-]?token|bot[_-]?token|client_secret|password|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s&\"',}]+/gi, '$1[скрыто]');
  return safe.slice(0, 900);
}

function classifyFailure(message: string, status: number): string {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 409) return 'STATE_CONFLICT';
  if (/another ip address|other ip address|привязан к другому ip|привязк.*ip/i.test(message)) return 'IP_RESTRICTED';
  if (/EAI_AGAIN|ENOTFOUND|DNS|name resolution|lookup failed|разрешени.*имен/i.test(message)) return 'DNS_UNAVAILABLE';
  if (/certificate|cert_|self.signed|TLS|SSL|issuer/i.test(message)) return 'TLS_FAILURE';
  if (/ETIMEDOUT|Timeout|timed out|fetch failed|network failure|ECONNREFUSED|ECONNRESET|network error/i.test(message)) return 'PROVIDER_UNAVAILABLE';
  if (/не заполнено|укажите|нужно|ожидается|неизвестная площадка|обязательн|invalid input/i.test(message)) return 'INVALID_INPUT';
  if (/не совпадает|chat not found|destination.*not found|сообщество не найдено|канал недоступен/i.test(message)) return 'DESTINATION_NOT_CONFIRMED';
  if (/permission|нет права|право wall|администратор|administrator|forbidden|not enough rights|недостаточно прав/i.test(message)) return 'PERMISSIONS_DENIED';
  if (/недействителен|неверный ключ|invalid token|invalid access_token|unauthorized|token expired|invalid auth/i.test(message)) return 'CREDENTIAL_REJECTED';
  return status >= 500 ? 'SERVER_ERROR' : 'CHECK_REJECTED';
}

export function registerSocialConnectionObservability(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0] || '';
    const tracked = operationFor(request.method, path);
    if (!tracked || reply.statusCode === 401) return payload;

    const status = reply.statusCode;
    const failed = status >= 400;
    let parsed: Record<string, unknown> | null = null;
    if (typeof payload === 'string') {
      try {
        const candidate: unknown = JSON.parse(payload);
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          parsed = candidate as Record<string, unknown>;
        }
      } catch {
        // Non-JSON and streaming responses are not modified.
      }
    }

    const safeMessage = safeProviderMessage(parsed?.message ?? parsed?.error, request.body);
    const code = failed ? classifyFailure(safeMessage, status) : 'SUCCESS';
    const diagnosticId = id('socialcheck');
    const platform = platformFromRequest(request.body, request.params);

    try {
      event({
        level: failed ? 'warning' : 'info',
        type: failed ? 'social_connection_attempt_failed' : 'social_connection_attempt_succeeded',
        message: `Соцсети: ${tracked.operation} / ${platform} / ${code} / HTTP ${status}`,
        data: {
          diagnosticId,
          platform,
          operation: tracked.operation,
          route: tracked.route,
          status,
          code
        }
      });
    } catch {
      // A diagnostic journal failure must never alter account persistence/verification.
      request.log.warn({ route: tracked.route, status, code }, 'Social connection diagnostic journal unavailable');
    }

    if (!failed || !parsed) return payload;
    return JSON.stringify({
      ...parsed,
      error: safeProviderMessage(parsed.error ?? parsed.message, request.body),
      ...(typeof parsed.message === 'string' ? { message: safeProviderMessage(parsed.message, request.body) } : {}),
      diagnosticId,
      diagnosticCode: code
    });
  });
}
