import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getVkOauthAuthorizationConfig } from '../config.js';
import { encryptJson, decryptJson } from '../crypto.js';
import { db, id, nowIso } from '../db.js';
import { testConnection } from '../platforms/connection-test.js';
import { resolveVkDestination, type VkDestinationKind } from '../platforms/vk.js';

const VK_OAUTH_AUTHORIZE_URL = 'https://oauth.vk.com/authorize';
const VK_OAUTH_TOKEN_URL = 'https://oauth.vk.com/access_token';
const VK_OAUTH_SCOPES = ['wall', 'groups', 'photos', 'offline'] as const;
const VK_OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
const VK_OAUTH_RESULT_TTL_MS = 5 * 60 * 1000;

type ConnectionRequest = { name: string; destinationKind: VkDestinationKind; groupId?: string };
type PendingState = { expiresAt: number; connection: ConnectionRequest };
type OauthResult = { expiresAt: number; ok: boolean; message: string };
const pendingStates = new Map<string, PendingState>();
const results = new Map<string, OauthResult>();

function randomId(): string {
  return randomBytes(32).toString('base64url');
}

function purgeExpired(now: number): void {
  for (const [state, pending] of pendingStates) if (pending.expiresAt <= now) pendingStates.delete(state);
  for (const [ticket, result] of results) if (result.expiresAt <= now) results.delete(ticket);
}

function issueState(connection: ConnectionRequest, now = Date.now()): string {
  purgeExpired(now);
  let state = randomId();
  while (pendingStates.has(state)) state = randomId();
  pendingStates.set(state, { expiresAt: now + VK_OAUTH_STATE_TTL_MS, connection });
  return state;
}

function takeState(state: string, now = Date.now()): PendingState | null {
  purgeExpired(now);
  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  return pending && pending.expiresAt > now ? pending : null;
}

// Retained for the VK-OAUTH-START acceptance contract.
export function consumeVkOauthState(state: string, now = Date.now()): boolean {
  return takeState(state, now) !== null;
}

function connectionRequest(query: Record<string, unknown>): ConnectionRequest {
  const destinationKind = String(query.destinationKind || 'PERSONAL').toUpperCase();
  if (destinationKind !== 'PERSONAL' && destinationKind !== 'COMMUNITY') {
    throw new Error('VK: выберите личную страницу или сообщество');
  }
  const name = String(query.name || 'VK').trim();
  if (!name || name.length > 100) throw new Error('VK: название подключения должно быть от 1 до 100 символов');
  if (destinationKind === 'PERSONAL') return { name, destinationKind };
  const groupId = String(query.groupId || '').trim();
  if (!groupId || groupId.length > 200) throw new Error('VK: укажите ID или ссылку сообщества');
  return { name, destinationKind, groupId };
}

function finish(reply: FastifyReply, ok: boolean, message: string): FastifyReply {
  purgeExpired(Date.now());
  const ticket = randomId();
  results.set(ticket, { expiresAt: Date.now() + VK_OAUTH_RESULT_TTL_MS, ok, message });
  return reply.redirect(`/socials?vk_oauth_result=${ticket}`);
}

async function exchangeCode(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<{ accessToken: string; userId: string | null; expiresIn: number | null }> {
  const url = new URL(VK_OAUTH_TOKEN_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('client_secret', clientSecret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);
  // VK's documented legacy Authorization Code Flow exchanges at this HTTPS endpoint.
  // Do not log this URL: it contains the application secret.
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  const payload: any = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('VK не выдал пользовательский ключ. Повторите авторизацию и проверьте настройки приложения VK.');
  }
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    userId: payload.user_id === undefined ? null : String(payload.user_id),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null
  };
}

function saveVerifiedConnection(connection: ConnectionRequest, credentials: Record<string, unknown>): 'created' | 'updated' {
  const destination = resolveVkDestination(credentials);
  const now = nowIso();
  return db.transaction(() => {
    const existing = db.prepare("SELECT id,credentials_encrypted FROM social_accounts WHERE platform='vk'").all() as
      Array<{ id: string; credentials_encrypted: string }>;
    for (const row of existing) {
      try {
        const stored = decryptJson<Record<string, unknown>>(row.credentials_encrypted);
        const savedDestination = resolveVkDestination(stored);
        if (savedDestination.kind !== destination.kind || savedDestination.id !== destination.id) continue;
        db.prepare('UPDATE social_accounts SET name=?,credentials_encrypted=?,enabled=1,updated_at=? WHERE id=?')
          .run(connection.name, encryptJson(credentials), now, row.id);
        return 'updated';
      } catch {
        // A malformed legacy record cannot block a new verified connection.
      }
    }
    const accountId = id('acc');
    db.prepare('INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)')
      .run(accountId, 'vk', connection.name, encryptJson(credentials), now, now);
    db.prepare(`INSERT INTO project_default_targets (project_id,account_id,created_at)
      SELECT id,?,? FROM projects WHERE default_targets_explicit=0`).run(accountId, now);
    return 'created';
  })();
}

export async function registerVkOauthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/vk/oauth/start', async (request, reply) => {
    let oauthConfig;
    try {
      oauthConfig = getVkOauthAuthorizationConfig();
    } catch {
      return reply.code(503).send({ error: 'VK OAuth настроен некорректно' });
    }
    if (!oauthConfig) {
      return reply.code(503).send({ error: 'VK OAuth не настроен: задайте VK_OAUTH_CLIENT_ID, VK_OAUTH_CLIENT_SECRET и VK_OAUTH_REDIRECT_URI' });
    }

    let connection: ConnectionRequest;
    try {
      connection = connectionRequest(request.query as Record<string, unknown>);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const state = issueState(connection);
    const authorizationUrl = new URL(VK_OAUTH_AUTHORIZE_URL);
    authorizationUrl.searchParams.set('client_id', oauthConfig.clientId);
    authorizationUrl.searchParams.set('display', 'page');
    authorizationUrl.searchParams.set('redirect_uri', oauthConfig.redirectUri);
    authorizationUrl.searchParams.set('scope', VK_OAUTH_SCOPES.join(','));
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('state', state);
    return { authorizationUrl: authorizationUrl.toString() };
  });

  // VK arrives from another site, so the Strict session cookie is intentionally
  // absent. The one-time state was issued only by the authenticated start route.
  app.get('/api/vk/oauth/callback', { logLevel: 'silent' }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const state = typeof query.state === 'string' ? query.state : '';
    const pending = takeState(state);
    if (!pending) return reply.code(400).send({ error: 'VK: срок авторизации истёк или ссылка уже использована' });
    if (query.error) return finish(reply, false, 'VK: доступ не предоставлен. Разрешите приложению публикацию и повторите подключение.');
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code || code.length > 2000) return finish(reply, false, 'VK: не получен код авторизации.');

    try {
      const oauthConfig = getVkOauthAuthorizationConfig();
      if (!oauthConfig) throw new Error('VK OAuth не настроен');
      const token = await exchangeCode(code, oauthConfig.clientId, oauthConfig.clientSecret, oauthConfig.redirectUri);
      const candidate: Record<string, unknown> = {
        accessToken: token.accessToken,
        apiVersion: '5.199',
        destinationKind: pending.connection.destinationKind,
        ...(pending.connection.groupId ? { groupId: pending.connection.groupId } : {})
      };
      const checked = await testConnection('vk', candidate);
      const details = checked.details || {};
      if (details.authKind !== 'USER' || details.destinationKind !== pending.connection.destinationKind || details.wallPhotoReady !== true) {
        throw new Error('VK: не подтверждены права пользователя на выбранную стену и загрузку фотографий');
      }
      if (token.userId && token.userId !== String(details.authenticatedUserId || '')) {
        throw new Error('VK: владелец ключа не совпал с авторизованным пользователем');
      }
      const destinationId = String(details.destinationId || '');
      if (!destinationId) throw new Error('VK: не получен ID выбранной стены');
      const credentials: Record<string, unknown> = {
        accessToken: token.accessToken,
        apiVersion: '5.199',
        authKind: 'USER',
        destinationKind: pending.connection.destinationKind,
        ...(pending.connection.destinationKind === 'COMMUNITY' ? { groupId: destinationId } : { userId: destinationId }),
        destinationName: String(details.destinationName || ''),
        ...(token.expiresIn ? { expiresAt: new Date(Date.now() + token.expiresIn * 1000).toISOString() } : {})
      };
      const action = saveVerifiedConnection(pending.connection, credentials);
      return finish(reply, true, action === 'updated'
        ? `VK: подключение обновлено · ${checked.destination}`
        : `VK: подключение сохранено · ${checked.destination}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Never expose a code, app secret or access token in callback URLs or result text.
      return finish(reply, false, message.slice(0, 400));
    }
  });

  app.get('/api/vk/oauth/result', async (request, reply) => {
    const ticket = String((request.query as Record<string, unknown>).ticket || '');
    const result = results.get(ticket);
    results.delete(ticket);
    if (!result || result.expiresAt <= Date.now()) return reply.code(404).send({ error: 'Результат авторизации VK истёк' });
    return { ok: result.ok, message: result.message };
  });
}
