import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';

assert.ok(process.argv[2], 'Pass the isolated oidc-provider installation directory');
const fixtureRequire = createRequire(join(resolve(process.argv[2]), 'package.json'));
const { Provider, errors } = await import(pathToFileURL(fixtureRequire.resolve('oidc-provider')).href);

const ownerId = 'synthetic-owner';
const clientId = 'publikator-fixture-client';
const clientSecret = randomBytes(32).toString('base64url');
const cookieKey = randomBytes(32).toString('base64url');
const grantedScopes = ['projects:read', 'posts:write'];
const authorizationPath = '/oauth/authorize';
const tokenPath = '/oauth/token';
const revocationPath = '/oauth/revoke';
const metadataPath = '/.well-known/oauth-authorization-server';
const resourceMetadataPath = '/.well-known/oauth-protected-resource/mcp';
const interactionPath = '/__oauth_fixture_interaction';

const app = Fastify({ logger: false });
let provider;
let provideOAuth;
let issuer;
let resource;
let redirect;

for (const [method, url] of [
  ['GET', metadataPath],
  ['GET', authorizationPath],
  ['GET', authorizationPath + '/:uid'],
  ['POST', tokenPath],
  ['POST', revocationPath],
]) {
  app.route({
    method,
    url,
    onRequest(request, reply, done) {
      reply.hijack();
      provideOAuth(request.raw, reply.raw);
      done();
    },
    handler() {
      throw new Error('OAuth requests must reach the provider before body parsing');
    },
  });
}

app.get(interactionPath + '/:uid', async (request, reply) => {
  // An isolated test fixture plays the owner. Production must validate the actual
  // owner session and a separate explicit consent POST before finishing either step.
  const details = await provider.interactionDetails(request.raw, reply.raw);
  assert.equal(details.uid, request.params.uid);
  assert.equal(details.params.client_id, clientId);
  let result;
  if (details.prompt.name === 'login') {
    result = { login: { accountId: ownerId, remember: false } };
  } else {
    assert.equal(details.prompt.name, 'consent');
    assert.equal(details.session.accountId, ownerId);
    const grant = new provider.Grant({ accountId: ownerId, clientId });
    grant.addResourceScope(resource, grantedScopes.join(' '));
    result = { consent: { grantId: await grant.save() } };
  }
  reply.hijack();
  await provider.interactionFinished(request.raw, reply.raw, result, {
    mergeWithLastSubmission: details.prompt.name === 'consent',
  });
});

app.get(resourceMetadataPath, (_request, reply) => reply.send({
  resource,
  authorization_servers: [issuer],
  scopes_supported: grantedScopes,
  bearer_methods_supported: ['header'],
}));

try {
  issuer = await app.listen({ host: '127.0.0.1', port: 0 });
  resource = issuer + '/mcp';
  redirect = issuer + '/__oauth_fixture_callback';
  provider = new Provider(issuer, {
    clients: [{
      client_id: clientId,
      client_secret: clientSecret,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'client_secret_post',
    }],
    cookies: {
      keys: [cookieKey],
      long: { secure: false },
      short: { secure: false },
    },
    findAccount: async (_context, accountId) => accountId === ownerId
      ? { accountId, claims: async () => ({ sub: ownerId }) }
      : undefined,
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        useGrantedResource: async () => false,
        async getResourceServerInfo(_context, requestedResource, client) {
          if (requestedResource !== resource || client.clientId !== clientId) {
            throw new errors.InvalidTarget();
          }
          return { scope: grantedScopes.join(' '), audience: resource, accessTokenTTL: 300 };
        },
      },
    },
    interactions: { url: (_context, interaction) => interactionPath + '/' + interaction.uid },
    issueRefreshToken: async () => true,
    rotateRefreshToken: true,
    pkce: { required: () => true },
    routes: { authorization: authorizationPath, token: tokenPath, revocation: revocationPath },
  });
  provideOAuth = provider.callback();

  const advertised = await fetch(issuer + metadataPath).then((response) => response.json());
  assert.equal(advertised.issuer, issuer);
  assert.equal(advertised.authorization_endpoint, issuer + authorizationPath);
  assert.equal(advertised.token_endpoint, issuer + tokenPath);
  assert.equal(advertised.revocation_endpoint, issuer + revocationPath);
  assert.ok(advertised.code_challenge_methods_supported.includes('S256'));
  assert.ok(advertised.token_endpoint_auth_methods_supported.includes('client_secret_post'));
  assert.equal(advertised.registration_endpoint, undefined);
  const advertisedResource = await fetch(issuer + resourceMetadataPath).then((response) => response.json());
  assert.deepEqual(advertisedResource.authorization_servers, [issuer]);
  assert.equal(advertisedResource.resource, resource);

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const authorization = {
    client_id: clientId,
    response_type: 'code',
    scope: grantedScopes.join(' '),
    redirect_uri: redirect,
    resource,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  };

  function authorize(overrides = {}) {
    const query = new URLSearchParams({ ...authorization, ...overrides });
    return issuer + authorizationPath + '?' + query.toString();
  }

  async function authorizeFixture() {
    const cookies = new Map();
    let destination = new URL(authorize());
    for (let hop = 0; hop < 8; hop += 1) {
      const cookie = [...cookies.values()]
        .filter(({ path }) => destination.pathname === path
          || destination.pathname.startsWith(path.endsWith('/') ? path : path + '/'))
        .map(({ pair }) => pair)
        .join('; ');
      const response = await fetch(destination, {
        redirect: 'manual',
        headers: cookie ? { Cookie: cookie } : undefined,
      });
      const next = response.headers.get('location');
      await response.body?.cancel();
      assert.ok(next, 'Expected OAuth redirect, got HTTP ' + response.status);
      for (const setCookie of response.headers.getSetCookie()) {
        const [pair, ...attributes] = setCookie.split('; ');
        const path = attributes.find((part) => /^path=/i.test(part))?.slice(5) ?? '/';
        const separator = pair.indexOf('=');
        const key = pair.slice(0, separator) + ' ' + path;
        if (!pair.slice(separator + 1)) cookies.delete(key);
        else cookies.set(key, { pair, path });
      }
      destination = new URL(next, destination);
      assert.equal(destination.origin, issuer);
      if (destination.pathname === new URL(redirect).pathname) {
        assert.equal(destination.searchParams.get('state'), state);
        assert.equal(destination.searchParams.has('error'), false);
        const code = destination.searchParams.get('code');
        assert.ok(code, 'Expected an OAuth authorization code');
        return code;
      }
    }
    assert.fail('OAuth authorization exceeded the redirect budget');
  }

  async function post(path, fields) {
    return fetch(issuer + path, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }),
    });
  }

  async function exchange(fields) {
    const response = await post(tokenPath, fields);
    return { status: response.status, payload: await response.json() };
  }

  function codeRequest(code, overrides = {}) {
    return {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource,
      ...overrides,
    };
  }

  const badRedirect = await fetch(authorize({ redirect_uri: redirect + '-wrong' }), { redirect: 'manual' });
  assert.equal(badRedirect.status, 400);
  assert.equal(badRedirect.headers.get('location'), null);
  await badRedirect.body?.cancel();
  const badResource = await fetch(authorize({ resource: issuer + '/elsewhere' }), { redirect: 'manual' });
  assert.equal(new URL(badResource.headers.get('location') ?? '', issuer).searchParams.get('error'), 'invalid_target');
  await badResource.body?.cancel();

  const wrongVerifier = await exchange(codeRequest(await authorizeFixture(), {
    code_verifier: randomBytes(32).toString('base64url'),
  }));
  assert.equal(wrongVerifier.status, 400);
  assert.equal(wrongVerifier.payload.error, 'invalid_grant');

  const initial = await exchange(codeRequest(await authorizeFixture()));
  assert.equal(initial.status, 200);
  const { access_token: accessToken, refresh_token: refreshToken } = initial.payload;
  assert.ok(accessToken);
  assert.ok(refreshToken);
  const stored = await provider.AccessToken.find(accessToken);
  assert.equal(stored?.aud, resource);
  assert.equal(stored?.accountId, ownerId);
  assert.equal(stored?.clientId, clientId);
  assert.deepEqual(stored?.scope.split(' ').sort(), [...grantedScopes].sort());

  const revoked = await post(revocationPath, { token: accessToken });
  assert.equal(revoked.status, 200);
  await revoked.body?.cancel();
  assert.equal(await provider.AccessToken.find(accessToken), undefined);

  const refresh = { grant_type: 'refresh_token', refresh_token: refreshToken, resource };
  const renewed = await exchange(refresh);
  assert.equal(renewed.status, 200);
  assert.ok(renewed.payload.refresh_token);
  assert.notEqual(renewed.payload.refresh_token, refreshToken);
  assert.equal((await provider.AccessToken.find(renewed.payload.access_token))?.aud, resource);
  const reused = await exchange(refresh);
  assert.equal(reused.status, 400);
  assert.equal(reused.payload.error, 'invalid_grant');

  console.log('OAuth compatibility: Fastify, metadata, static authentication, S256 PKCE, resource, refresh, and revocation PASS');
} finally {
  await app.close();
}
