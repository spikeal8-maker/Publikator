import assert from 'node:assert/strict';

const {
  VK_DIRECT_DNS_PROVIDERS,
  buildVkTlsRequestOptions,
  isDnsResolutionError,
  resolveVkHostname,
  resolveVkHostnameDirect,
  vkFetch
} = await import('../dist/platforms/vk-transport.js');

function dnsError(code, hostname) {
  const cause = new Error(`getaddrinfo ${code} ${hostname}`);
  cause.code = code;
  const error = new TypeError('fetch failed');
  error.cause = cause;
  return error;
}

// A. System/network path remains primary. Public fallback must stay idle.
{
  let fetchCalls = 0;
  let directCalls = 0;
  let dohCalls = 0;
  let resolvedCalls = 0;
  const response = await vkFetch('https://api.vk.com/method/users.get', { method: 'GET' }, {
    fetchImpl: async (url) => {
      fetchCalls += 1;
      assert.equal(new URL(String(url)).hostname, 'api.vk.com');
      return new Response('{"response":[]}', { status: 200 });
    },
    resolveDirect: async () => {
      directCalls += 1;
      throw new Error('direct DNS must not run');
    },
    resolveDoh: async () => {
      dohCalls += 1;
      throw new Error('DoH must not run');
    },
    requestResolved: async () => {
      resolvedCalls += 1;
      throw new Error('resolved-IP request must not run');
    }
  });
  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 1);
  assert.equal(directCalls, 0);
  assert.equal(dohCalls, 0);
  assert.equal(resolvedCalls, 0);
}

// B. EAI_AGAIN on the normal path uses direct DNS first, then resolved-IP HTTPS.
{
  let directHost = '';
  let dohCalls = 0;
  let requestHost = '';
  const response = await vkFetch('https://api.vk.com/method/users.get?v=5.199', { method: 'GET' }, {
    fetchImpl: async () => { throw dnsError('EAI_AGAIN', 'api.vk.com'); },
    resolveDirect: async (hostname) => {
      directHost = hostname;
      return { address: '203.0.113.10', family: 4, source: 'google' };
    },
    resolveDoh: async () => {
      dohCalls += 1;
      throw new Error('DoH must not run after direct DNS succeeds');
    },
    requestResolved: async (url, init, resolved) => {
      requestHost = url.hostname;
      assert.equal(resolved.address, '203.0.113.10');
      assert.equal(init.method, 'GET');
      return new Response('{"error":{"error_code":5}}', { status: 200 });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(directHost, 'api.vk.com');
  assert.equal(requestHost, 'api.vk.com');
  assert.equal(dohCalls, 0);
}

// C. Direct resolver order is Google, then Cloudflare.
{
  const seen = [];
  const resolved = await resolveVkHostnameDirect('api.vk.com', async (provider, hostname) => {
    seen.push({ id: provider.id, servers: [...provider.servers], hostname });
    if (provider.id === 'google') throw new Error('google-direct-down');
    return ['198.51.100.25'];
  });
  assert.deepEqual(seen, [
    { id: 'google', servers: ['8.8.8.8', '8.8.4.4'], hostname: 'api.vk.com' },
    { id: 'cloudflare', servers: ['1.1.1.1', '1.0.0.1'], hostname: 'api.vk.com' }
  ]);
  assert.deepEqual(resolved, { address: '198.51.100.25', family: 4, source: 'cloudflare' });
}

// D1. Both direct resolvers failing produces a deterministic direct-DNS error.
{
  await assert.rejects(
    resolveVkHostnameDirect('api.vk.com', async (provider) => {
      throw new Error(`${provider.id}-direct-down`);
    }),
    /VK direct DNS failed for api\.vk\.com: google: google-direct-down; cloudflare: cloudflare-direct-down/
  );
}

// D2. Existing HTTPS DoH remains tertiary only after direct DNS fails.
{
  const sequence = [];
  const resolved = await resolveVkHostname('api.vk.com', {
    resolveDirect: async () => {
      sequence.push('direct');
      throw new Error('all direct resolvers failed');
    },
    resolveDoh: async (hostname) => {
      sequence.push('doh');
      assert.equal(hostname, 'api.vk.com');
      return { address: '192.0.2.20', family: 4, source: 'cloudflare' };
    }
  });
  assert.deepEqual(sequence, ['direct', 'doh']);
  assert.deepEqual(resolved, { address: '192.0.2.20', family: 4, source: 'cloudflare' });
}

// D3. Direct DNS and DoH both failing returns one deterministic hostname-scoped error.
{
  await assert.rejects(
    resolveVkHostname('api.vk.com', {
      resolveDirect: async () => { throw new Error('direct-all-down'); },
      resolveDoh: async () => { throw new Error('doh-all-down'); }
    }),
    /VK DNS fallback failed for api\.vk\.com: direct DNS: direct-all-down; DoH: doh-all-down/
  );
}

// E. Resolved IP is the socket destination, while Host/SNI and certificate verification stay original.
{
  const url = new URL('https://api.vk.com/method/wall.post?x=1');
  const options = buildVkTlsRequestOptions(
    url,
    { address: '203.0.113.77', family: 4, source: 'google' },
    'POST',
    { 'content-type': 'application/x-www-form-urlencoded' }
  );
  assert.equal(options.hostname, '203.0.113.77');
  assert.equal(options.servername, 'api.vk.com');
  assert.equal(options.headers.Host, 'api.vk.com');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.method, 'POST');
  assert.equal(options.path, '/method/wall.post?x=1');
}

// F. An arbitrary VK upload hostname uses the exact same direct resolver path.
{
  let directHost = '';
  let resolvedRequestHost = '';
  let dohCalls = 0;
  const response = await vkFetch('https://pu.vk.example/upload/image?sig=redacted', {
    method: 'POST',
    body: 'upload-body'
  }, {
    fetchImpl: async () => { throw dnsError('ENOTFOUND', 'pu.vk.example'); },
    resolveDirect: async (hostname) => {
      directHost = hostname;
      return { address: '192.0.2.55', family: 4, source: 'cloudflare' };
    },
    resolveDoh: async () => {
      dohCalls += 1;
      throw new Error('DoH must not run');
    },
    requestResolved: async (url, init, resolved) => {
      resolvedRequestHost = url.hostname;
      assert.equal(resolved.address, '192.0.2.55');
      assert.equal(init.method, 'POST');
      return new Response('{"server":1,"photo":"[]","hash":"ok"}', { status: 200 });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(directHost, 'pu.vk.example');
  assert.equal(resolvedRequestHost, 'pu.vk.example');
  assert.equal(dohCalls, 0);
}

// Non-DNS transport failures must not activate any DNS fallback.
{
  let directCalls = 0;
  const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  await assert.rejects(
    vkFetch('https://api.vk.com/method/users.get', {}, {
      fetchImpl: async () => { throw error; },
      resolveDirect: async () => {
        directCalls += 1;
        return { address: '203.0.113.1', family: 4, source: 'google' };
      }
    }),
    /connection reset/
  );
  assert.equal(directCalls, 0);
}

assert.deepEqual(
  VK_DIRECT_DNS_PROVIDERS.map((provider) => ({ id: provider.id, servers: [...provider.servers] })),
  [
    { id: 'google', servers: ['8.8.8.8', '8.8.4.4'] },
    { id: 'cloudflare', servers: ['1.1.1.1', '1.0.0.1'] }
  ]
);
assert.equal(isDnsResolutionError(dnsError('EAI_AGAIN', 'api.vk.com')), true);
assert.equal(isDnsResolutionError(dnsError('ENOTFOUND', 'api.vk.com')), true);

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'VK-DOCKER-DNS-RUNTIME-001',
  systemPathPrimary: true,
  directDnsOnResolutionFailure: true,
  googleThenCloudflare: true,
  dohTertiaryOnly: true,
  deterministicFailure: true,
  originalHostnameTls: true,
  certificateVerificationEnabled: true,
  genericUploadHostname: true,
  vkOnlyTransport: true
}, null, 2));
