import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getVkOauthAuthorizationConfig } from '../config.js';

const VK_OAUTH_AUTHORIZE_URL = 'https://oauth.vk.com/authorize';
const VK_OAUTH_SCOPES = ['wall', 'groups', 'photos', 'offline'] as const;
const VK_OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
const pendingStates = new Map<string, number>();

function purgeExpiredStates(now: number): void {
  for (const [state, expiresAt] of pendingStates) {
    if (expiresAt <= now) pendingStates.delete(state);
  }
}

function issueState(now = Date.now()): string {
  purgeExpiredStates(now);
  let state = '';
  do {
    state = randomBytes(32).toString('base64url');
  } while (pendingStates.has(state));
  pendingStates.set(state, now + VK_OAUTH_STATE_TTL_MS);
  return state;
}

export function consumeVkOauthState(state: string, now = Date.now()): boolean {
  purgeExpiredStates(now);
  const expiresAt = pendingStates.get(state);
  if (!expiresAt || expiresAt <= now) {
    pendingStates.delete(state);
    return false;
  }
  pendingStates.delete(state);
  return true;
}

export async function registerVkOauthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/vk/oauth/start', async (_request, reply) => {
    let oauthConfig;
    try {
      oauthConfig = getVkOauthAuthorizationConfig();
    } catch {
      return reply.code(503).send({ error: 'VK OAuth настроен некорректно' });
    }
    if (!oauthConfig) {
      return reply.code(503).send({
        error: 'VK OAuth не настроен: отсутствуют VK_OAUTH_CLIENT_ID и/или VK_OAUTH_REDIRECT_URI'
      });
    }

    const state = issueState();
    const authorizationUrl = new URL(VK_OAUTH_AUTHORIZE_URL);
    authorizationUrl.searchParams.set('client_id', oauthConfig.clientId);
    authorizationUrl.searchParams.set('display', 'page');
    authorizationUrl.searchParams.set('redirect_uri', oauthConfig.redirectUri);
    authorizationUrl.searchParams.set('scope', VK_OAUTH_SCOPES.join(','));
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('state', state);

    return { authorizationUrl: authorizationUrl.toString() };
  });
}
