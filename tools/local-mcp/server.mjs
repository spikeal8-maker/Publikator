/**
 * Optional local MCP stdio bridge over the existing trusted Integration API v1.
 * NOT the remotely accessible OAuth MCP service, and NOT per-agent authorization.
 * No direct provider access, no browser admin session and no publication tools.
 *
 * stdout belongs exclusively to the MCP transport. Never log API tokens.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const MAX_RESPONSE_BYTES = 256 * 1024;
const key = process.env.PUBLIKATOR_LOCAL_MCP_KEY ?? '';
const origin = process.env.PUBLIKATOR_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080';

function localOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('LOCAL_URL_INVALID'); }
  // Do not allow a user-supplied URL to turn MCP into an SSRF/proxy tool.
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '') ||
      !url.port || url.port === '0') {
    throw Error('LOCAL_URL_NOT_LOOPBACK');
  }
  return url.origin;
}

if (!/^pk_[A-Za-z0-9_-]{40,}$/.test(key)) {
  console.error('MCP startup refused: missing or malformed local integration key.');
  process.exit(2);
}

let apiBase;
try { apiBase = localOrigin(origin) + '/api/integration/v1'; }
catch { console.error('MCP startup refused: only explicit 127.0.0.1 HTTP is supported.'); process.exit(2); }

async function readBoundedJson(response) {
  let length = 0;
  const pieces = [];
  if (!response.body) throw Error('LOCAL_API_INVALID_RESPONSE');
  const reader = response.body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw Error('LOCAL_API_RESPONSE_TOO_LARGE');
      pieces.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
    return parsed;
  } catch { throw Error('LOCAL_API_INVALID_JSON'); }
}

async function apiRequest(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { authorization: 'Bearer ' + key, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
  let response;
  try {
    response = await fetch(apiBase + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12_000)
    });
  } catch { throw Error('LOCAL_API_UNAVAILABLE'); }

  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw Error('LOCAL_API_RESPONSE_TOO_LARGE');
  }
  // Ignore untrusted provider/HTTP response messages when reporting a failure.
  // Status and bounded machine-readable code are sufficient for local operator diagnosis.
  if (!response.ok) {
    const status = response.status;
    let code = 'HTTP_' + status;
    try {
      const error = await readBoundedJson(response);
      const proposed = error?.error?.code;
      if (typeof proposed === 'string' && /^[A-Z0-9_:-]{1,48}$/.test(proposed)) code = proposed;
    } catch { /* An error page must never become an MCP tool result. */ }
    throw Error('LOCAL_API_REJECTED_' + code);
  }
  return readBoundedJson(response);
}

function safePost(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.id !== 'string' || !/^post_[A-Za-z0-9-]{10,100}$/.test(value.id)) {
    throw Error('LOCAL_API_INVALID_POST');
  }
  // Allowlist: future provider credentials or unrecognized fields cannot flow to MCP.
  return {
    id: value.id,
    project: typeof value.project === 'string' ? value.project : null,
    internalTitle: typeof value.internalTitle === 'string' ? value.internalTitle : null,
    body: typeof value.body === 'string' ? value.body : null,
    contentFormat: typeof value.contentFormat === 'string' ? value.contentFormat : null,
    publicationStatus: typeof value.publicationStatus === 'string' ? value.publicationStatus : null,
    contentVersion: Number.isSafeInteger(value.contentVersion) ? value.contentVersion : null
  };
}

function success(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

async function guarded(fn) {
  try { return success(await fn()); }
  catch (error) {
    const code = error instanceof Error ? error.message : 'LOCAL_TOOL_FAILURE';
    // Never pass exception stacks or arbitrary HTTP body/provider data to a model.
    return { isError: true, content: [{ type: 'text', text: /^LOCAL_[A-Z0-9_:-]+$/.test(code) ? code : 'LOCAL_TOOL_FAILURE' }] };
  }
}

// Require a genuine scoped integration key before advertising any tools.
try { await apiRequest('/drafts?limit=1&offset=0'); }
catch {
  console.error('MCP startup refused: local Publikator API not reachable or key lacks read scope.');
  process.exit(3);
}

const server = new McpServer({ name: 'publikator-local', version: '0.1.0' });

server.registerTool('get_connection_status', {
  description: 'Read-only health of the local Publikator Integration API. Cannot publish or schedule.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({}).strict()
}, async () => guarded(async () => {
  const value = await apiRequest('/drafts?limit=1&offset=0');
  return {
    connected: true, mode: 'LOCAL_DRAFT_ONLY', canPublish: false,
    draftTotal: Number.isSafeInteger(value.total) ? value.total : null
  };
}));

server.registerTool('list_drafts', {
  description: 'List drafts in the trusted shared legacy Integration API namespace. Not per-agent isolated.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({
    limit: z.number().int().min(1).max(20).default(10),
    offset: z.number().int().min(0).default(0)
  }).strict()
}, async ({ limit, offset }) => guarded(async () => {
  const value = await apiRequest('/drafts?limit=' + limit + '&offset=' + offset);
  if (!Array.isArray(value.items)) throw Error('LOCAL_API_INVALID_RESPONSE');
  return {
    items: value.items.map(safePost), limit, offset,
    nextOffset: Number.isSafeInteger(value.nextOffset) ? value.nextOffset : null,
    total: Number.isSafeInteger(value.total) ? value.total : null
  };
}));

server.registerTool('get_draft', {
  description: 'Read a specific Integration API draft by exact post ID. Never returns provider credentials.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({ postId: z.string().regex(/^post_[A-Za-z0-9-]{10,100}$/) }).strict()
}, async ({ postId }) => guarded(async () => {
  return safePost(await apiRequest('/drafts/' + encodeURIComponent(postId)));
}));

server.registerTool('create_text_draft', {
  description: 'Create TEXT_ONLY DRAFT without recipients, scheduling or sending. Stable idempotencyKey required.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({
    projectSlug: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/),
    title: z.string().min(1).max(160),
    body: z.string().min(1).max(20_000),
    idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
  }).strict()
}, async ({ projectSlug, title, body, idempotencyKey }) => guarded(async () => {
  const response = await apiRequest('/drafts', {
    method: 'POST', idempotencyKey,
    body: {
      project: projectSlug, externalId: idempotencyKey, internalTitle: title, body,
      publicationKind: 'FEED', contentFormat: 'TEXT_ONLY',
      schedule: { mode: 'MANUAL' }, targets: []
    }
  });
  return { replay: response.replay === true, post: safePost(response.post) };
}));

const transport = new StdioServerTransport();
await server.connect(transport);
process.once('SIGINT', () => { void server.close(); });
process.once('SIGTERM', () => { void server.close(); });
