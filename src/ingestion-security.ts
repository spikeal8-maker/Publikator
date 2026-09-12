import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';

export const DEFAULT_BUNDLE_LIMITS = {
  maxEntries: 2000,
  maxCompressedBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
  maxEntryExpandedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 100
} as const;

export type BundleEntryKind = 'file' | 'directory' | 'symlink' | 'device' | 'fifo' | 'other';
export type BundleEntryMeta = {
  path: string;
  kind: BundleEntryKind;
  compressedSize: number;
  expandedSize: number;
};

export type BundleLimits = {
  maxEntries: number;
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxEntryExpandedBytes: number;
  maxCompressionRatio: number;
};const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function canonicalBundlePath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').normalize('NFC');
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('//')) throw new Error('Archive path must be relative');
  if (/^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) throw new Error('Archive path is unsafe');
  if (normalized.length > 512) throw new Error('Archive path is too long');

  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') throw new Error('Archive traversal is forbidden');
    if (segment.endsWith('.') || segment.endsWith(' ')) throw new Error('Archive path is unsafe on Windows');
    if (WINDOWS_DEVICE_NAME.test(segment)) throw new Error('Archive device filename is forbidden');
    if (/[<>:"|?*\u0000-\u001F]/.test(segment)) throw new Error('Archive filename contains forbidden characters');
  }
  return segments.join('/');
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

export function validateBundleEntries(entries: BundleEntryMeta[], limits: BundleLimits = DEFAULT_BUNDLE_LIMITS): string[] {
  if (entries.length > limits.maxEntries) throw new Error(`Archive has more than ${limits.maxEntries} entries`);
  const seen = new Set<string>();
  let compressedTotal = 0;
  let expandedTotal = 0;
  const canonicalPaths: string[] = [];

  for (const entry of entries) {
    if (entry.kind !== 'file' && entry.kind !== 'directory') throw new Error(`Archive entry type ${entry.kind} is forbidden`);
    const canonical = canonicalBundlePath(entry.path);
    const collisionKey = canonical.toLocaleLowerCase('en-US');
    if (seen.has(collisionKey)) throw new Error(`Archive has duplicate path ${canonical}`);
    seen.add(collisionKey);
    canonicalPaths.push(canonical);

    const compressed = safeInteger(entry.compressedSize, 'compressedSize');
    const expanded = safeInteger(entry.expandedSize, 'expandedSize');
    if (entry.kind === 'directory' && expanded !== 0) throw new Error('Directory entry must have zero expanded size');
    if (expanded > limits.maxEntryExpandedBytes) throw new Error('Archive entry exceeds expanded-size limit');
    if (expanded > 0 && compressed === 0) throw new Error('Archive entry has unsafe compression ratio');
    if (compressed > 0 && expanded / compressed > limits.maxCompressionRatio) throw new Error('Archive entry exceeds compression-ratio limit');
    compressedTotal += compressed;
    expandedTotal += expanded;
    if (compressedTotal > limits.maxCompressedBytes) throw new Error('Archive exceeds compressed-size limit');
    if (expandedTotal > limits.maxExpandedBytes) throw new Error('Archive exceeds expanded-size limit');
  }
  return canonicalPaths;
}

function ipv4Number(address: string): number | null {
  if (net.isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
}

function ipv4InCidr(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Number(base);
  if (baseValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

const BLOCKED_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
];

const BLOCKED_IPV6 = new net.BlockList();
for (const [base, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
] as Array<[string, number]>) BLOCKED_IPV6.addSubnet(base, prefix, 'ipv6');

export function isBlockedIngestionIp(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== null) return BLOCKED_IPV4.some(([base, prefix]) => ipv4InCidr(v4, base, prefix));
  if (net.isIP(address) !== 6) return true;
  return BLOCKED_IPV6.check(address, 'ipv6');
}

export type HostResolver = (hostname: string) => Promise<string[]>;
type ResolvedRemoteTarget = { url: URL; hostname: string; addresses: string[]; selectedAddress: string };

async function defaultHostResolver(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) return [hostname];
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}
async function resolveRemoteMediaTarget(rawUrl: string, resolver: HostResolver): Promise<ResolvedRemoteTarget> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error('Remote media URL is invalid'); }
  if (parsed.protocol !== 'https:') throw new Error('Remote media URL must use HTTPS');
  if (parsed.username || parsed.password) throw new Error('Remote media URL must not contain credentials');
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new Error('Remote media URL has no hostname');
  const addresses = [...new Set(await resolver(hostname))];
  if (addresses.length === 0) throw new Error('Remote media hostname did not resolve');
  for (const address of addresses) if (isBlockedIngestionIp(address)) throw new Error(`Remote media destination is blocked: ${address}`);
  const selectedAddress = addresses.find((address) => net.isIP(address) === 4) ?? addresses[0]!;
  return { url: parsed, hostname, addresses, selectedAddress };
}

export async function validateRemoteMediaUrl(rawUrl: string, resolver: HostResolver = defaultHostResolver): Promise<URL> {
  return (await resolveRemoteMediaTarget(rawUrl, resolver)).url;
}

async function pinnedHttpsResponse(target: ResolvedRemoteTarget, maxBytes: number, timeoutMs: number, requestImpl: typeof https.request): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    const request = requestImpl({
      protocol: 'https:', hostname: target.selectedAddress, port: target.url.port ? Number(target.url.port) : 443,
      method: 'GET', path: `${target.url.pathname}${target.url.search}`, agent: false,
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
      headers: { host: target.url.host, accept: '*/*' }, rejectUnauthorized: true
    }, (response) => {
      const status = response.statusCode ?? 502;
      const length = Number(response.headers['content-length'] ?? '0');
      if (Number.isFinite(length) && length > maxBytes) { response.resume(); fail(new Error('Remote media exceeds size limit')); return; }
      const chunks: Buffer[] = []; let total = 0;
      response.on('data', (raw: Buffer | string) => { const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); total += chunk.length;
        if (total > maxBytes) { response.destroy(); fail(new Error('Remote media exceeds streamed size limit')); return; } chunks.push(chunk); });
      response.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
      response.on('end', () => { if (settled) return; settled = true; const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) { if (Array.isArray(value)) value.forEach((item) => headers.append(key, item)); else if (value !== undefined) headers.set(key, String(value)); }
        resolve(new Response(Buffer.concat(chunks), { status, headers })); });
    });
    const timer = setTimeout(() => request.destroy(new Error('Remote media request timed out')), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
    request.end();
  });
}

export type SniffedMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'video/mp4';

export function sniffMediaMime(buffer: Buffer): SniffedMime | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (buffer.length >= 6 && ['GIF87a','GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(4,8).toString('ascii') === 'ftyp') return 'video/mp4';
  return null;
}

export type RemoteFetchOptions = {
  resolver?: HostResolver;
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  requestImpl?: typeof https.request;
};

export async function fetchRemoteMedia(rawUrl: string, options: RemoteFetchOptions = {}): Promise<{ url: string; mimeType: SniffedMime; buffer: Buffer }> {
  const resolver = options.resolver ?? defaultHostResolver;
  const fetchImpl = options.fetchImpl;
  if (fetchImpl && process.env.NODE_ENV !== 'test') throw new Error('Custom remote-media fetch implementation is test-only');
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let current = rawUrl;

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const target = await resolveRemoteMediaTarget(current, resolver);
    let response: Response;
    if (fetchImpl) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try { response = await fetchImpl(target.url, { redirect: 'manual', signal: controller.signal }); }
      finally { clearTimeout(timeout); }
    } else {
      response = await pinnedHttpsResponse(target, maxBytes, timeoutMs, options.requestImpl ?? https.request);
    }

    if (response.status >= 300 && response.status < 400) {
      if (redirect === maxRedirects) throw new Error('Remote media redirect limit exceeded');
      const location = response.headers.get('location');
      if (!location) throw new Error('Remote media redirect has no Location');
      current = new URL(location, target.url).toString();
      continue;
    }

    if (!response.ok) throw new Error(`Remote media request failed with HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('Remote media exceeds size limit');
    if (!response.body) throw new Error('Remote media response has no body');

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Remote media exceeds streamed size limit');
      }
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    const mimeType = sniffMediaMime(buffer);
    if (!mimeType) throw new Error('Remote media MIME is not recognized');
    const headerMime = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (headerMime && headerMime !== 'application/octet-stream' && headerMime !== mimeType) {
      throw new Error(`Remote media MIME mismatch: header=${headerMime}, bytes=${mimeType}`);
    }
    return { url: target.url.toString(), mimeType, buffer };
  }
  throw new Error('Remote media redirect limit exceeded');
}

export function spreadsheetSafeText(value: string): string {
  if (/^[\t\r\n]/.test(value) || /^\s*[=+\-@]/.test(value)) return `'${value}`;
  return value;
}

const SAFE_RICH_NODE_TYPES = new Set([
  'doc', 'paragraph', 'text', 'link', 'bullet_list', 'ordered_list',
  'list_item', 'blockquote', 'code_block', 'hard_break'
]);
const SAFE_RICH_MARK_TYPES = new Set(['bold', 'italic', 'underline', 'strike', 'code']);
const MAX_RICH_NODES = 10_000;
const MAX_RICH_DEPTH = 32;
const MAX_RICH_TEXT_BYTES = 1024 * 1024;

function assertSafeLink(href: string): void {
  let url: URL;
  try { url = new URL(href); } catch { throw new Error('Rich-text link is invalid'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Rich-text link protocol is forbidden');
  if (href.length > 2048) throw new Error('Rich-text link is too long');
  if (url.username || url.password) throw new Error('Rich-text link credentials are forbidden');
}

export function assertSafeRichTextAst(value: unknown): void {
  let nodes = 0;
  let textBytes = 0;

  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_RICH_DEPTH) throw new Error('Rich-text AST exceeds max depth');
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Rich-text node must be an object');
    const record = node as Record<string, unknown>;
    const type = String(record.type ?? '');
    if (!SAFE_RICH_NODE_TYPES.has(type)) throw new Error(`Rich-text node type is forbidden: ${type || 'missing'}`);
    nodes += 1;
    if (nodes > MAX_RICH_NODES) throw new Error('Rich-text AST has too many nodes');
    const allowedKeys = new Set(['type', 'text', 'content', 'marks', 'attrs']);
    for (const key of Object.keys(record)) {
      if (!allowedKeys.has(key) || /^on/i.test(key) || /html/i.test(key)) throw new Error(`Rich-text property is forbidden: ${key}`);
    }

    if (type === 'text') {
      if (typeof record.text !== 'string') throw new Error('Rich-text text node requires text');
      textBytes += Buffer.byteLength(record.text, 'utf8');
      if (textBytes > MAX_RICH_TEXT_BYTES) throw new Error('Rich-text text exceeds size limit');
    } else if (record.text !== undefined) {
      throw new Error('Only text nodes may contain text');
    }

    if (record.attrs !== undefined) {
      if (!record.attrs || typeof record.attrs !== 'object' || Array.isArray(record.attrs)) throw new Error('Rich-text attrs must be an object');
      const attrs = record.attrs as Record<string, unknown>;
      if (type !== 'link') throw new Error('Rich-text attrs are only allowed on links in security foundation');
      for (const key of Object.keys(attrs)) if (!['href', 'title'].includes(key)) throw new Error(`Rich-text link attr is forbidden: ${key}`);
      if (typeof attrs.href !== 'string') throw new Error('Rich-text link requires href');
      assertSafeLink(attrs.href);
      if (attrs.title !== undefined && typeof attrs.title !== 'string') throw new Error('Rich-text link title must be text');
      if (typeof attrs.title === 'string' && attrs.title.length > 512) throw new Error('Rich-text link title is too long');
    }

    if (record.marks !== undefined) {
      if (type !== 'text') throw new Error('Rich-text marks are only allowed on text nodes');
      if (!Array.isArray(record.marks)) throw new Error('Rich-text marks must be an array');
      for (const mark of record.marks) {
        if (!mark || typeof mark !== 'object' || Array.isArray(mark)) throw new Error('Rich-text mark must be an object');
        const markRecord = mark as Record<string, unknown>;
        if (Object.keys(markRecord).some((key) => key !== 'type')) throw new Error('Rich-text mark contains forbidden properties');
        const markType = String(markRecord.type ?? '');
        if (!SAFE_RICH_MARK_TYPES.has(markType)) throw new Error(`Rich-text mark is forbidden: ${markType || 'missing'}`);
      }
    }

    if (record.content !== undefined) {
      if (type === 'text') throw new Error('Rich-text text nodes cannot contain child content');
      if (!Array.isArray(record.content)) throw new Error('Rich-text content must be an array');
      for (const child of record.content) visit(child, depth + 1);
    }
  };

  visit(value, 0);
}

export function securityFingerprint(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
