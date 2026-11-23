import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Provider, errors } from 'oidc-provider';
import { sessionAdmin } from '../admin-auth.js';
import { createSQLiteOAuthAdapter } from '../agent-oauth-adapter.js';
import { config } from '../config.js';
import { db, nowIso } from '../db.js';
import { ownerMutationOriginMatches } from './security.js';

const metadata = '/.well-known/oauth-authorization-server';
export const CHATGPT_MCP_PATH = '/mcp/chatgpt';
export const CHATGPT_RESOURCE_METADATA = '/.well-known/oauth-protected-resource' + CHATGPT_MCP_PATH;
const authorization = '/oauth/authorize';
const token = '/oauth/token';
const revoke = '/oauth/revoke';
const jwksPath = '/oauth/jwks';
const interaction = '/oauth/interaction';
const defaultRedirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const idPattern = /^[a-zA-Z0-9._:-]{1,128}$/;

type GrantRow = {
  id: string;
  status: string;
  agentExpiresAt: string | null;
  grantExpiresAt: string | null;
  tokenVersion: number;
  grantVersion: number;
  scopeIds: string;
};

export type VerifiedChatGPTGrant = {
  agentId: string;
  grantVersion: number;
  tokenVersion: number;
  scopeIds: string[];
};

const bindingModel = 'PublikatorOAuthBinding';
const keyModel = 'PublikatorOAuthSigningKey';

function publicOrigin() {
  const url = new URL(config.publicBaseUrl);
  const localTest = process.env.NODE_ENV === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!localTest && url.protocol !== 'https:') || url.href !== url.origin + '/') {
    throw new Error('ChatGPT OAuth requires a canonical HTTPS PUBLIC_BASE_URL');
  }
  return url;
}

function validateConfiguration() {
  const clientId = process.env.PUBLIKATOR_CHATGPT_OAUTH_CLIENT_ID;
  const secret = process.env.PUBLIKATOR_CHATGPT_OAUTH_CLIENT_SECRET;
  const agentId = process.env.PUBLIKATOR_CHATGPT_AGENT_ID;
  const redirect = process.env.PUBLIKATOR_CHATGPT_OAUTH_REDIRECT_URI || defaultRedirect;
  if (!clientId && !secret && !agentId && redirect === defaultRedirect) return null;
  if (!clientId || !idPattern.test(clientId) || !secret || !/^[A-Za-z0-9_-]{43,128}$/.test(secret)
    || !agentId || !idPattern.test(agentId)) {
    throw new Error('Incomplete or invalid ChatGPT OAuth configuration');
  }
  const url = new URL(redirect);
  const localTest = process.env.NODE_ENV === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (!localTest && (url.origin !== 'https://chatgpt.com' || url.href !== redirect || url.search || url.hash
    || !(redirect === defaultRedirect || /^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(url.pathname)))) {
    throw new Error('ChatGPT OAuth requires the exact approved callback URL');
  }
  return { clientId, secret, agentId, redirect, origin: publicOrigin() };
}

function currentGrant(agentId: string): VerifiedChatGPTGrant | null {
  const row = db.prepare(`
    SELECT p.id, p.status, p.token_version AS tokenVersion, p.expires_at AS agentExpiresAt,
      g.expires_at AS grantExpiresAt, g.grant_version AS grantVersion, g.scope_ids_json AS scopeIds
    FROM agent_principals p JOIN agent_grants g ON p.id = g.agent_id
    WHERE p.id = ? AND p.client_kind = 'chatgpt' AND p.owner_admin_id = 'owner'
  `).get(agentId) as GrantRow | undefined;
  const now = nowIso();
  if (!row || row.status !== 'ACTIVE' || (row.agentExpiresAt && row.agentExpiresAt <= now)
    || (row.grantExpiresAt && row.grantExpiresAt <= now)) return null;
  const scopes = JSON.parse(row.scopeIds) as string[];
  if (!scopes.length) return null;
  return { agentId, grantVersion: row.grantVersion, tokenVersion: row.tokenVersion, scopeIds: scopes };
}

function headers(reply: FastifyReply) {
  return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY')
    .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
}

function ownerForm(reply: FastifyReply, uid: string, grant: VerifiedChatGPTGrant, scopes: string[], loggedIn: boolean) {
  const safeScopes = scopes.filter((scope) => /^[a-z][a-z:._-]{1,90}$/.test(scope)).join(', ');
  const actions = loggedIn
    ? `<p>Разрешения: ${safeScopes}</p><form method="post" action="${interaction}/${uid}">
<input type="hidden" name="grant" value="${grant.grantVersion}.${grant.tokenVersion}">
<button name="decision" value="allow">Разрешить</button><button name="decision" value="deny">Отклонить</button></form>`
    : '<p><a href="/" target="_blank" rel="noopener">Войти в Publikator</a>, затем обновите эту страницу.</p>';
  return headers(reply).type('text/html; charset=utf-8').send(
    '<!doctype html><html lang="ru"><meta charset="utf-8"><title>ChatGPT в Publikator</title>' +
    '<h1>Подключение ChatGPT</h1>' + actions + '</html>',
  );
}

export async function registerChatGPTIssuer(app: FastifyInstance) {
  const settings = validateConfiguration();
  if (!settings) return null;

  const issuer = settings.origin.origin;
  const secure = settings.origin.protocol === 'https:';
  const resource = issuer + CHATGPT_MCP_PATH;
  const adapter = createSQLiteOAuthAdapter(db);
  const bindings = adapter(bindingModel);
  const keys = adapter(keyModel);
  let key = await keys.find('chatgpt-issuer-v1');
  if (!key) {
    const privateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
    key = { ...privateKey, kid: randomUUID(), use: 'sig', alg: 'ES256' };
    await keys.upsert('chatgpt-issuer-v1', key);
  }
  if (typeof key.d !== 'string' || typeof key.kid !== 'string') throw new Error('Invalid OAuth signing key');
  type ProviderConfig = NonNullable<ConstructorParameters<typeof Provider>[1]>;
  const signingKey = key as NonNullable<ProviderConfig['jwks']>['keys'][number];

  const provider = new Provider(issuer, {
    adapter,
    jwks: { keys: [signingKey] },
    clients: [{
      client_id: settings.clientId,
      client_secret: settings.secret,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [settings.redirect],
      token_endpoint_auth_method: 'client_secret_post',
      id_token_signed_response_alg: 'ES256',
    }],
    cookies: {
      keys: [createHmac('sha256', config.masterKey).update('publikator.chatgpt.oidc.cookies.v1').digest('base64url')],
      short: { secure, sameSite: 'lax' },
      long: { secure, sameSite: 'lax' },
    },
    findAccount: async (_context, accountId) => accountId === 'owner' && currentGrant(settings.agentId)
      ? { accountId, claims: async () => ({ sub: accountId }) }
      : undefined,
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        useGrantedResource: async () => false,
        async getResourceServerInfo(_context, target, client) {
          const live = currentGrant(settings.agentId);
          if (target !== resource || client.clientId !== settings.clientId || !live) {
            throw new errors.InvalidTarget();
          }
          return { scope: live.scopeIds.join(' '), audience: resource, accessTokenTTL: 300 };
        },
      },
    },
    interactions: { url: (_context, prompt) => interaction + '/' + prompt.uid },
    pkce: { required: () => true },
    rotateRefreshToken: true,
    routes: { authorization, token, revocation: revoke, jwks: jwksPath },
  });
  provider.proxy = secure;
  const provide = provider.callback();

  function checkOrigin(request: FastifyRequest, reply: FastifyReply): boolean {
    if (request.headers.host !== settings!.origin.host || request.protocol !== (secure ? 'https' : 'http')) {
      headers(reply).code(400).send({ error: 'invalid_request' });
      return false;
    }
    return true;
  }

  function normalizeProxy(request: FastifyRequest) {
    const remote = request.raw.headers;
    delete remote['x-forwarded-host'];
    delete remote['x-forwarded-port'];
    delete remote['x-forwarded-for'];
    remote['x-forwarded-proto'] = request.protocol;
  }

  for (const [method, url] of [
    ['GET', metadata], ['GET', '/.well-known/openid-configuration'], ['GET', authorization],
    ['GET', authorization + '/:uid'], ['GET', jwksPath], ['POST', token], ['POST', revoke],
  ] as const) {
    app.route({
      method, url,
      onRequest(request, reply, done) {
        if (!checkOrigin(request, reply)) { done(); return; }
        normalizeProxy(request);
        reply.raw.setHeader('Cache-Control', 'no-store');
        reply.raw.setHeader('Referrer-Policy', 'no-referrer');
        reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
        reply.raw.setHeader('X-Frame-Options', 'DENY');
        reply.hijack();
        provide(request.raw, reply.raw);
        done();
      },
      handler: async () => { throw new Error('OAuth provider route was not handled'); },
    });
  }

  for (const path of [CHATGPT_RESOURCE_METADATA, '/.well-known/oauth-protected-resource']) {
    app.get(path, async (request, reply) => {
      if (!checkOrigin(request, reply)) return;
      return headers(reply).send({
        resource, authorization_servers: [issuer],
        scopes_supported: ['projects:read', 'accounts:read', 'posts:write', 'offline_access'],
        bearer_methods_supported: ['header'],
      });
    });
  }

  await app.register(async (browser) => {
    browser.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 },
      (_request, body, done) => done(null, body));
    browser.get<{ Params: { uid: string } }>(interaction + '/:uid', {
      onSend(_request, reply, payload, done) {
        // Chrome must include the same-origin Origin on a navigation form POST.
        // The route hook runs after the global no-referrer default.
        reply.header('Referrer-Policy', 'strict-origin');
        done(null, payload);
      },
    }, async (request, reply) => {
      if (!checkOrigin(request, reply)) return;
      const live = currentGrant(settings.agentId);
      if (!live || !idPattern.test(request.params.uid)) return headers(reply).code(404).send('Сеанс подключения недоступен.');
      try {
        normalizeProxy(request);
        const details = await provider.interactionDetails(request.raw, reply.raw);
        if (details.uid !== request.params.uid || details.params.client_id !== settings.clientId) {
          return headers(reply).code(400).send('Сеанс подключения недействителен.');
        }
        const requested = new Set(String(details.params.scope ?? '').split(' '));
        return ownerForm(reply, details.uid, live, live.scopeIds.filter((scope) => requested.has(scope)),
          Boolean(sessionAdmin(request.cookies.publikator_session)));
      } catch {
        return headers(reply).code(400).send('Сеанс подключения недействителен.');
      }
    });
    browser.post<{ Params: { uid: string }; Body: string }>(interaction + '/:uid', async (request, reply) => {
      if (!checkOrigin(request, reply)) return;
      if (request.headers.authorization || !sessionAdmin(request.cookies.publikator_session)
        || !ownerMutationOriginMatches(request) || !idPattern.test(request.params.uid)) {
        return headers(reply).code(403).send('Требуется локальная сессия владельца и подтверждение.');
      }
      const input = new URLSearchParams(request.body);
      const decision = input.get('decision');
      if ([...input].length !== 2 || input.getAll('decision').length !== 1 || !['allow', 'deny'].includes(decision ?? '')) {
        return headers(reply).code(400).send('Выберите действие.');
      }
      const live = currentGrant(settings.agentId);
      if (!live) return headers(reply).code(403).send('Подключение ChatGPT отключено.');
      if (input.get('grant') !== live.grantVersion + '.' + live.tokenVersion) {
        return headers(reply).code(409).send('Разрешения изменились. Обновите страницу.');
      }
      try {
        normalizeProxy(request);
        const details = await provider.interactionDetails(request.raw, reply.raw);
        if (details.uid !== request.params.uid || details.params.client_id !== settings.clientId) {
          return headers(reply).code(400).send('Сеанс подключения недействителен.');
        }
        let result: Parameters<Provider['interactionFinished']>[2];
        const consent = details.prompt.name === 'consent';
        if (decision === 'deny') result = { error: 'access_denied' };
        else if (details.prompt.name === 'login') result = { login: { accountId: 'owner', remember: false } };
        else if (consent && details.session?.accountId === 'owner') {
          const requested = String(details.params.scope ?? '').split(' ');
          const scopes = live.scopeIds.filter((scope) => requested.includes(scope));
          if (!scopes.length) return headers(reply).code(403).send('Запрошенные права недоступны.');
          const grant = new provider.Grant({ accountId: 'owner', clientId: settings.clientId });
          grant.addResourceScope(resource, scopes.join(' '));
          if (requested.includes('offline_access')) grant.addOIDCScope('offline_access');
          const grantId = await grant.save();
          await bindings.upsert(grantId, { ...live, scopeIds: scopes }, grant.expiration);
          result = { consent: { grantId } };
        } else return headers(reply).code(400).send('Сеанс подключения недействителен.');
        const returnTo = await provider.interactionResult(request.raw, reply.raw, result, { mergeWithLastSubmission: consent });
        return headers(reply).redirect(returnTo, 303);
      } catch {
        return headers(reply).code(400).send('Не удалось подтвердить OAuth-подключение.');
      }
    });
  });

  return {
    resource,
    async authenticate(bearer: string): Promise<VerifiedChatGPTGrant | null> {
      const access = await provider.AccessToken.find(bearer);
      if (access?.aud !== resource || access.clientId !== settings.clientId || access.accountId !== 'owner' || !access.grantId) return null;
      const link = await bindings.find(access.grantId);
      const live = currentGrant(settings.agentId);
      if (!live || link?.agentId !== live.agentId || link.tokenVersion !== live.tokenVersion
        || link.grantVersion !== live.grantVersion || !Array.isArray(link.scopeIds)) return null;
      const issued = new Set(access.scope?.split(' ') ?? []);
      const scopeIds = live.scopeIds.filter((scope) => issued.has(scope) && (link.scopeIds as unknown[]).includes(scope));
      return scopeIds.length ? { ...live, scopeIds } : null;
    },
  };
}

export function clearRestoredOAuthSessions() {
  db.prepare('DELETE FROM agent_oauth_artifacts WHERE model <> ?').run(keyModel);
}
