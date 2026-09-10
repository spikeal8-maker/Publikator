import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'"
].join('; ');

function configuredPublicOrigin(): string | null {
  if (!config.publicBaseUrl) return null;
  try {
    const url = new URL(config.publicBaseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

const PUBLIC_ORIGIN = configuredPublicOrigin();
const PUBLIC_HTTPS = PUBLIC_ORIGIN?.startsWith('https://') ?? false;

function requestOriginAllowed(request: FastifyRequest, originHeader: string): boolean {
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;

  if (PUBLIC_ORIGIN && origin.origin === PUBLIC_ORIGIN) return true;

  const requestHost = request.headers.host?.trim().toLowerCase();
  if (!requestHost) return false;
  return origin.host.toLowerCase() === requestHost;
}

export async function registerBrowserSecurity(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || !MUTATING_METHODS.has(request.method)) return;

    const rawOrigin = request.headers.origin;
    if (rawOrigin === undefined) return;
    if (typeof rawOrigin !== 'string' || !requestOriginAllowed(request, rawOrigin)) {
      return reply.code(403).send({ error: 'Запрос отклонён: недопустимый Origin' });
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('content-security-policy', CSP);
    reply.header('cross-origin-opener-policy', 'same-origin');

    if (request.url.startsWith('/public-media/')) {
      reply.header('cross-origin-resource-policy', 'cross-origin');
    } else {
      reply.header('cross-origin-resource-policy', 'same-origin');
    }

    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    if (PUBLIC_HTTPS) reply.header('strict-transport-security', 'max-age=31536000');
    return payload;
  });
}
