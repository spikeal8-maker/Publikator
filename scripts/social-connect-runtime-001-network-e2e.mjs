import assert from 'node:assert/strict';

const {
  VK_DOH_ENDPOINTS,
  buildVkTlsRequestOptions,
  isDnsResolutionError,
  resolveVkHostnameWithDoh,
  vkFetch
} = await import('../dist/platforms/vk-transport.js');

function dnsError(code, hostname) {
  const cause = new Error(`getaddrinfo ${code} ${hostname}`);
  cause.code = code;
  const error = new TypeError('fetch failed');
  error.cause = cause;
  return error;
}

// 1. Normal system/network path stays primary and never invokes DoH.
{
  let fetchCalls = 0;
  let dohCalls = 0;
  let resolvedCalls = 0;
  const response = await vkFetch('https://api.vk.com/method/users.get', { method: 'POST' }, {
    fetchImpl: async (url) => {
      fetchCalls += 1;
      assert.equal(new URL(String(url)).hostname, 'api.vk.com');
      return new Response('{"response":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    resolveDoh: async () => {
      dohCalls += 1;
      throw new Error('DoH must not run');
    },
    requestResolved: async () => {
      resolvedCalls += 1;
      throw new Error('resolved request must not run');
    }
  });
  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 1);
  assert.equal(dohCalls, 0);
  assert.equal(resolvedCalls, 0);
}

// 2. System resolver EAI_AGAIN triggers DoH and the resolved HTTPS request.
{
  let resolvedHostname = '';
  let connectedAddress = '';
  const response = await vkFetch('https://api.vk.com/method/groups.getById', {
    method: 'POST',
    body: new URLSearchParams({ group_id: '1' })
  }, {
    fetchImpl: async () => { throw dnsError('EAI_AGAIN', 'api.vk.com'); },
    resolveDoh: async (hostname) => {
      resolvedHostname = hostname;
      return { address: '203.0.113.10', family: 4, source: 'google' };
    },
    requestResolved: async (url, init, resolved) => {
      connectedAddress = resolved.address;
      assert.equal(url.hostname, 'api.vk.com');
      assert.equal(init.method, 'POST');
      return new Response('{"response":{"groups":[]}}', { status: 200 });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(resolvedHostname, 'api.vk.com');
  assert.equal(connectedAddress, '203.0.113.10');
}

// 3. Primary DoH failure falls through to the secondary endpoint.
{
  const seen = [];
  const resolved = await resolveVkHostnameWithDoh('api.vk.com', async (endpoint, hostname) => {
    seen.push([endpoint.id, hostname]);
    if (endpoint.id === 'google') throw new Error('primary unavailable');
    return ['198.51.100.25'];
  });
  assert.deepEqual(seen, [['google', 'api.vk.com'], ['cloudflare', 'api.vk.com']]);
  assert.deepEqual(resolved, { address: '198.51.100.25', family: 4, source: 'cloudflare' });
}

// 4. Fallback connects to the resolved IP while preserving the original Host/SNI and certificate checks.
{
  const url = new URL('https://api.vk.com/method/photos.getWallUploadServer?x=1');
  const options = buildVkTlsRequestOptions(
    url,
    { address: '203.0.113.11', family: 4, source: 'google' },
    'POST',
    { 'content-type': 'application/x-www-form-urlencoded' }
  );
  assert.equal(options.hostname, '203.0.113.11');
  assert.equal(options.servername, 'api.vk.com');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.path, '/method/photos.getWallUploadServer?x=1');
  assert.equal(options.headers.Host, 'api.vk.com');
  assert.equal(options.method, 'POST');
}

// 5. An arbitrary HTTPS upload host returned by VK uses the same fallback transport.
{
  let fallbackHost = '';
  let requestHost = '';
  const response = await vkFetch('https://upload.vk.example/upload/photo?token=redacted', {
    method: 'POST',
    body: 'payload'
  }, {
    fetchImpl: async () => { throw dnsError('ENOTFOUND', 'upload.vk.example'); },
    resolveDoh: async (hostname) => {
      fallbackHost = hostname;
      return { address: '192.0.2.44', family: 4, source: 'cloudflare' };
    },
    requestResolved: async (url, init, resolved) => {
      requestHost = url.hostname;
      assert.equal(resolved.address, '192.0.2.44');
      assert.equal(init.method, 'POST');
      return new Response('{"server":1,"photo":"[]","hash":"ok"}', { status: 200 });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(fallbackHost, 'upload.vk.example');
  assert.equal(requestHost, 'upload.vk.example');
}

// 6. Both DoH providers failing produces a deterministic hostname-scoped error.
{
  await assert.rejects(
    resolveVkHostnameWithDoh('api.vk.com', async (endpoint) => {
      throw new Error(`${endpoint.id}-down`);
    }),
    /VK DNS fallback failed for api\.vk\.com: google: google-down; cloudflare: cloudflare-down/
  );
}

// 7. Non-DNS failures do not trigger the DNS fallback.
{
  let fallbackCalls = 0;
  const nonDns = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  await assert.rejects(
    vkFetch('https://api.vk.com/method/users.get', {}, {
      fetchImpl: async () => { throw nonDns; },
      resolveDoh: async () => {
        fallbackCalls += 1;
        return { address: '203.0.113.1', family: 4, source: 'google' };
      }
    }),
    /connection reset/
  );
  assert.equal(fallbackCalls, 0);
}

assert.equal(isDnsResolutionError(dnsError('EAI_AGAIN', 'api.vk.com')), true);
assert.equal(isDnsResolutionError(dnsError('ENOTFOUND', 'api.vk.com')), true);
assert.equal(isDnsResolutionError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), false);
assert.deepEqual(VK_DOH_ENDPOINTS.map((endpoint) => endpoint.hostname), ['dns.google', 'cloudflare-dns.com']);

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'SOCIAL-CONNECT-RUNTIME-001',
  normalDnsPath: true,
  eaiAgainDohFallback: true,
  primarySecondaryDoh: true,
  tlsHostnamePreserved: true,
  certificateVerificationEnabled: true,
  uploadHostFallback: true,
  deterministicDohFailure: true,
  vkOnlyTransport: true
}, null, 2));
