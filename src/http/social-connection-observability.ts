import type { FastifyInstance } from 'fastify';
import { decryptJson } from '../crypto.js';
import { db, event, id } from '../db.js';

type Operation = 'inspect' | 'check' | 'save' | 'recheck' | 'activate' | 'update' | 'oauth';
type TrackedOperation = { route: string; operation: Operation };

const SOCIAL_PLATFORMS = new Set(['telegram', 'max', 'vk', 'instagram']);
const PRIVATE_FIELDS = new Set([
  'accesstoken', 'bottoken', 'uploadaccesstoken', 'clientsecret', 'password',
  'apikey', 'refreshtoken', 'authorization', 'token', 'privatekey',
  'credentialsencrypted', 'credentials', 'idtoken', 'oauthcode', 'authorizationcode', 'secret'
]);
const SAFE_REASONS: Record<string, string> = {
  INVALID_INPUT: 'Не заполнены или некорректны поля подключения. Проверьте ключ и назначение.',
  CREDENTIAL_REJECTED: 'Площадка отклонила ключ: ключ недействителен или срок его действия истёк. Проверьте разрешения.',
  IP_RESTRICTED: 'VK отклонил ключ: он привязан к другому IP-адресу. Проверьте разрешённый IP для этого ключа.',
  PERMISSIONS_DENIED: 'Не подтверждено право публикации. Проверьте роль бота или владельца ключа.',
  DESTINATION_NOT_CONFIRMED: 'Назначение не подтверждено. Проверьте ID канала или сообщества и права доступа.',
  DNS_UNAVAILABLE: 'Не удалось разрешить адрес API площадки (DNS). Проверьте доступность DNS.',
  TLS_FAILURE: 'Ошибка проверки TLS-сертификата. Проверка сертификатов не отключена.',
  TRANSPORT_UNAVAILABLE: 'Соединение с API площадки не установлено. Проверьте сетевой доступ.',
  TIMEOUT: 'Площадка не ответила за отведённое время. Повторите проверку позже.',
  PROVIDER_UNAVAILABLE: 'Проверка ключа временно недоступна. API площадки временно недоступен. Повторите проверку позже.',
  RATE_LIMITED: 'Площадка ограничила частоту запросов. Повторите проверку позже.',
  STATE_CONFLICT: 'Подключение изменилось во время проверки. Повторите проверку текущего ключа.',
  SERVER_ERROR: 'Внутренняя ошибка проверки. Сообщите диагностический ID разработчику.',
  CHECK_REJECTED: 'Проверка не подтверждена. Проверьте ключ, назначение и права.'
};

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
  if (method === 'GET' && path === '/api/vk/oauth/callback') return { route: 'vk.oauth.callback', operation: 'oauth' };
  if (method === 'GET' && path === '/api/vk/oauth/result') return { route: 'vk.oauth.result', operation: 'oauth' };
  return null;
}

export function socialLogPath(url: string): string {
  // OAuth code/state/ticket and mistakenly supplied tokens must never be access-logged.
  return url.split(/[?#]/, 1)[0] || '/';
}

function knownPlatform(value: unknown): string | null {
  return typeof value === 'string' && SOCIAL_PLATFORMS.has(value.toLowerCase()) ? value.toLowerCase() : null;
}

function platformFromRequest(body: unknown, params: unknown, tracked: TrackedOperation): string {
  if (tracked.route.startsWith('vk.')) return 'vk';
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

function privateField(key: string): boolean {
  return PRIVATE_FIELDS.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}

function privateValues(body: unknown, params: unknown): string[] {
  const values = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || !value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      if (privateField(key) && typeof field === 'string' && field) values.add(field);
      else if (field && typeof field === 'object') visit(field, depth + 1);
    }
  };
  visit(body, 0);
  const accountId = params && typeof params === 'object'
    ? (params as Record<string, unknown>).id : undefined;
  if (typeof accountId === 'string' && accountId.length < 151) {
    try {
      const stored = db.prepare('SELECT credentials_encrypted FROM social_accounts WHERE id=?')
        .get(accountId) as { credentials_encrypted: string } | undefined;
      if (stored) visit(decryptJson<unknown>(stored.credentials_encrypted), 0);
    } catch {
      // Failure responses are always fixed classified text, even if an older secret cannot be decrypted.
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function redactText(text: string, secrets: string[]): string {
  let safe = text;
  for (const secret of secrets) {
    safe = safe.replaceAll(secret, '[скрыто]');
    try { safe = safe.replaceAll(encodeURIComponent(secret), '[скрыто]'); }
    catch { /* Invalid Unicode is handled by literal redaction above. */ }
  }
  return safe
    .replace(/\/bot\d{4,}:[A-Za-z0-9_-]+/gi, '/bot[скрыто]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{10,}\b/g, '[скрыто]')
    .replace(/\bvk1\.[A-Za-z0-9_.-]{15,}/gi, '[скрыто]')
    .replace(/([?&](?:access_token|bot_token|client_secret|token|api_key)=)[^&#\s]+/gi, '$1[скрыто]')
    .replace(/((?:access[_-]?token|bot[_-]?token|client_secret|password|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s&"',}]+/gi, '$1[скрыто]')
    .slice(0, 1000);
}

function safeSuccessResponse(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 8) return '[дополнительные данные скрыты]';
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 150).map(item => safeSuccessResponse(item, secrets, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (privateField(key)) continue;
    result[key] = safeSuccessResponse(field, secrets, depth + 1);
  }
  return result;
}

function classifyFailure(message: string, status: number): string {
  // A classified error from our own secure exception handler must retain
  // its code when the onSend hook records it a second time.
  const alreadyClassified = Object.entries(SAFE_REASONS)
    .find(([, safeReason]) => safeReason === message);
  if (alreadyClassified) return alreadyClassified[0];
  if (status === 429) return 'RATE_LIMITED';
  if (status === 409) return 'STATE_CONFLICT';
  if (/another ip address|other ip address|привязан к другому ip|привязк.*ip/i.test(message)) return 'IP_RESTRICTED';
  if (/EAI_AGAIN|ENOTFOUND|DNS|name resolution|lookup failed|разрешени.*имен/i.test(message)) return 'DNS_UNAVAILABLE';
  if (/certificate|cert_|self.signed|TLS|SSL|issuer/i.test(message)) return 'TLS_FAILURE';
  if (/ETIMEDOUT|Timeout|timed out|aborterror|aborted|превышено время/i.test(message)) return 'TIMEOUT';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|TCP connect/i.test(message)) return 'TRANSPORT_UNAVAILABLE';
  if (/fetch failed|network failure|network error|недоступен сервер|временно недоступн|temporarily unavailable|service unavailable/i.test(message)) return 'PROVIDER_UNAVAILABLE';
  if (/не заполнено|укажите|нужно|ожидается|неизвестная площадка|обязательн|invalid input/i.test(message)) return 'INVALID_INPUT';
  if (/не совпадает|chat not found|destination.*not found|сообщество не найдено|канал недоступен/i.test(message)) return 'DESTINATION_NOT_CONFIRMED';
  if (/permission|нет права|право wall|администратор|administrator|forbidden|not enough rights|недостаточно прав/i.test(message)) return 'PERMISSIONS_DENIED';
  if (/недействителен|неверный ключ|invalid token|invalid access_token|unauthorized|token expired|invalid auth/i.test(message)) return 'CREDENTIAL_REJECTED';
  return status >= 500 ? 'SERVER_ERROR' : 'CHECK_REJECTED';
}

export function safeSocialFailureMessage(message: unknown, status = 400): string {
  return SAFE_REASONS[classifyFailure(typeof message === 'string' ? message : '', status)] || 'Проверка не подтверждена.';
}

export function registerSocialConnectionObservability(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const tracked = operationFor(request.method, socialLogPath(request.url));
    if (!tracked) return reply.send(error);
    // Unhandled provider exceptions can carry a decrypted saved secret in their stack.
    // Do not pass them to Fastify's default error logger.
    const safeError = error && typeof error === 'object'
      ? error as { statusCode?: unknown; message?: unknown } : {};
    const status = typeof safeError.statusCode === 'number' && safeError.statusCode >= 400
      && safeError.statusCode < 600 ? safeError.statusCode : 500;
    return reply.code(status).send({
      error: status >= 500 ? SAFE_REASONS.SERVER_ERROR : safeSocialFailureMessage(safeError.message, status)
    });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const tracked = operationFor(request.method, socialLogPath(request.url));
    if (!tracked) return payload;
    if (reply.statusCode === 401) {
      // Do not fill the journal with unauthenticated probes, but also never
      // let an accidental credential echo escape through a 401 response.
      reply.removeHeader('content-length');
      reply.type('application/json');
      return JSON.stringify({ error: 'Требуется вход' });
    }

    const status = reply.statusCode;
    let parsed: Record<string, unknown> | null = null;
    if (typeof payload === 'string') {
      try {
        const candidate: unknown = JSON.parse(payload);
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          parsed = candidate as Record<string, unknown>;
        }
      } catch {
        // Redirect and stream responses retain their existing semantics.
      }
    }
    const failed = status >= 400 || (tracked.route === 'vk.oauth.result' && parsed?.ok === false);
    const rawError = parsed?.error ?? parsed?.message;
    const code = failed ? classifyFailure(typeof rawError === 'string' ? rawError : '', status) :
      status >= 300 && status < 400 ? 'REDIRECT' : 'SUCCESS';
    const diagnosticId = id('socialcheck');
    const platform = platformFromRequest(request.body, request.params, tracked);

    try {
      event({
        level: failed ? 'warning' : 'info',
        type: failed ? 'social_connection_attempt_failed' : 'social_connection_attempt_succeeded',
        // The legacy Journal UI displays only the message, not data_json:
        // include the non-secret ID so an engineer can find this attempt.
        message: 'Соцсети: ' + tracked.operation + ' / ' + platform + ' / ' + code
          + ' / HTTP ' + status + ' / ID ' + diagnosticId,
        data: { diagnosticId, platform, operation: tracked.operation, route: tracked.route, status, code }
      });
    } catch {
      request.log.warn({ route: tracked.route, status, code }, 'Social connection diagnostic journal unavailable');
    }

    if (failed) {
      // Whitelist only our own diagnostic fields. Never spread provider/exception
      // objects, which can include arbitrary nested tokens and URLs.
      reply.removeHeader('content-length');
      reply.type('application/json');
      const safeReason = SAFE_REASONS[code] || SAFE_REASONS.CHECK_REJECTED;
      if (tracked.route === 'vk.oauth.result' && parsed?.ok === false) {
        // OAuth's legacy 200 response contains { ok:false, message }; keep its
        // result shape without propagating the untrusted provider message.
        return JSON.stringify({ ok: false, message: safeReason, diagnosticId, diagnosticCode: code });
      }
      return JSON.stringify({ error: safeReason, diagnosticId, diagnosticCode: code });
    }
    if (!parsed) return payload;
    // Successful provider responses can also contain unsafe identity/debug fields.
    const safe = safeSuccessResponse(parsed, privateValues(request.body, request.params));
    reply.removeHeader('content-length');
    return JSON.stringify(safe);
  });
}
