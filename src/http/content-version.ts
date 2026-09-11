import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ContentConflictError,
  ContentImmutableError,
  ContentNotFoundError
} from '../content-versioning.js';

export function expectedContentVersion(
  request: FastifyRequest,
  body?: Record<string, unknown>
): number {
  const fromBody = body?.expectedContentVersion;
  const fromHeader = request.headers['x-content-version'];
  const raw = fromBody ?? (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader);
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('expectedContentVersion обязателен и должен быть положительным целым числом');
  }
  return value;
}

export function contentMutationError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ContentNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof ContentConflictError || error instanceof ContentImmutableError) {
    return reply.code(409).send({ error: error.message });
  }
  return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
}
