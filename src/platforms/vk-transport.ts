import https, { type RequestOptions } from 'node:https';
import { isIP } from 'node:net';

const VK_DOH_TIMEOUT_MS = 5_000;
const VK_FALLBACK_TIMEOUT_MS = 30_000;

export type VkResolvedAddress = {
  address: string;
  family: 4 | 6;
  source: 'google' | 'cloudflare';
};

export type VkDohEndpoint = {
  id: 'google' | 'cloudflare';
  hostname: string;
  path: string;
  bootstrapAddresses: readonly string[];
};

export const VK_DOH_ENDPOINTS: readonly VkDohEndpoint[] = [
  {
    id: 'google',
    hostname: 'dns.google',
    path: '/resolve',
    bootstrapAddresses: ['8.8.8.8', '8.8.4.4']
  },
  {
    id: 'cloudflare',
    hostname: 'cloudflare-dns.com',
    path: '/dns-query',
    bootstrapAddresses: ['1.1.1.1', '1.0.0.1']
  }
];

type VkTransportDependencies = {
  fetchImpl?: typeof fetch;
  resolveDoh?: (hostname: string) => Promise<VkResolvedAddress>;
  requestResolved?: (url: URL, init: RequestInit, resolved: VkResolvedAddress) => Promise<Response>;
};

type DohQuery = (endpoint: VkDohEndpoint, hostname: string) => Promise<string[]>;

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code.toUpperCase() : '';
}

export function isDnsResolutionError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === 'object') {
    if (seen.has(current as object)) break;
    seen.add(current as object);
    const code = errorCode(current);
    if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') return true;
    const message = current instanceof Error ? current.message : String((current as { message?: unknown }).message || '');
    if (/\b(?:EAI_AGAIN|ENOTFOUND|getaddrinfo)\b/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function httpsJsonRequest(options: RequestOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      ...options,
      method: 'GET',
      rejectUnauthorized: true
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        const status = response.statusCode || 0;
        const text = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) {
          reject(new Error(`DoH HTTP ${status}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          reject(new Error('DoH returned invalid JSON'));
        }
      });
    });
    request.setTimeout(VK_DOH_TIMEOUT_MS, () => request.destroy(new Error('DoH request timed out')));
    request.on('error', reject);
    request.end();
  });
}

async function queryDohEndpoint(endpoint: VkDohEndpoint, hostname: string): Promise<string[]> {
  const query = `${endpoint.path}?name=${encodeURIComponent(hostname)}&type=A`;
  let lastError: unknown = null;
  for (const bootstrapAddress of endpoint.bootstrapAddresses) {
    try {
      const payload = await httpsJsonRequest({
        protocol: 'https:',
        hostname: bootstrapAddress,
        port: 443,
        path: query,
        servername: endpoint.hostname,
        headers: {
          Host: endpoint.hostname,
          Accept: 'application/dns-json'
        }
      }) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
      if (payload.Status !== undefined && payload.Status !== 0) throw new Error(`DoH DNS status ${payload.Status}`);
      const addresses = Array.isArray(payload.Answer)
        ? payload.Answer
          .filter((answer) => answer?.type === 1 && typeof answer.data === 'string' && isIP(answer.data) === 4)
          .map((answer) => String(answer.data))
        : [];
      if (addresses.length) return addresses;
      throw new Error('DoH returned no IPv4 address');
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${endpoint.hostname}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function resolveVkHostnameWithDoh(hostname: string, query: DohQuery = queryDohEndpoint): Promise<VkResolvedAddress> {
  const failures: string[] = [];
  for (const endpoint of VK_DOH_ENDPOINTS) {
    try {
      const addresses = await query(endpoint, hostname);
      const address = addresses.find((candidate) => isIP(candidate) === 4);
      if (!address) throw new Error('no usable IPv4 address');
      return { address, family: 4, source: endpoint.id };
    } catch (error) {
      failures.push(`${endpoint.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`VK DNS fallback failed for ${hostname}: ${failures.join('; ')}`);
}

export function buildVkTlsRequestOptions(
  url: URL,
  resolved: VkResolvedAddress,
  method: string,
  headers: Record<string, string>
): RequestOptions {
  return {
    protocol: 'https:',
    hostname: resolved.address,
    port: url.port ? Number(url.port) : 443,
    method,
    path: `${url.pathname}${url.search}`,
    servername: url.hostname,
    rejectUnauthorized: true,
    headers: {
      ...headers,
      Host: url.host
    }
  };
}

async function requestViaResolvedAddress(url: URL, init: RequestInit, resolved: VkResolvedAddress): Promise<Response> {
  if (url.protocol !== 'https:') throw new Error(`VK DNS fallback requires HTTPS: ${url.protocol}`);

  const normalized = new Request(url.toString(), init);
  const body = normalized.body ? Buffer.from(await normalized.arrayBuffer()) : null;
  const headers: Record<string, string> = {};
  normalized.headers.forEach((value, key) => { headers[key] = value; });
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-length')) {
    headers['Content-Length'] = String(body.byteLength);
  }

  const options = buildVkTlsRequestOptions(url, resolved, normalized.method, headers);
  return await new Promise<Response>((resolve, reject) => {
    const request = https.request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item));
          else if (value !== undefined) responseHeaders.set(key, String(value));
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode || 500,
          statusText: response.statusMessage || '',
          headers: responseHeaders
        }));
      });
    });

    const abort = () => request.destroy(new Error('VK request aborted'));
    if (init.signal?.aborted) {
      abort();
      return;
    }
    init.signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => init.signal?.removeEventListener('abort', abort));
    request.setTimeout(VK_FALLBACK_TIMEOUT_MS, () => request.destroy(new Error('VK request timed out')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

export async function vkFetch(
  input: string | URL,
  init: RequestInit = {},
  dependencies: VkTransportDependencies = {}
): Promise<Response> {
  const url = new URL(String(input));
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (!isDnsResolutionError(error)) throw error;
    const resolveDoh = dependencies.resolveDoh || resolveVkHostnameWithDoh;
    const requestResolved = dependencies.requestResolved || requestViaResolvedAddress;
    const resolved = await resolveDoh(url.hostname);
    return await requestResolved(url, init, resolved);
  }
}
