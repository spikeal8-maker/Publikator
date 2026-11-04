import { AgentRegistryError } from '../agent-registry-error.js';

export const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
export type Page = { limit: number; after: string };

function invalidPage(message: string): never {
  throw new AgentRegistryError('VALIDATION_ERROR', message, 400);
}

export function parsePage(query: unknown): Page {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    invalidPage('Некорректные параметры списка.');
  }
  const params = query as Record<string, unknown>;
  if (Object.keys(params).some(k => k !== 'limit' && k !== 'cursor')) {
    invalidPage('Допустимы только limit и cursor.');
  }
  let limit = 50;
  if (params.limit !== undefined) {
    const raw = params.limit;
    if (typeof raw !== 'string' || !/^[1-9]\d{0,2}$/.test(raw)
      || Number(raw) > 100) {
      invalidPage('Допустимый limit: от 1 до 100.');
    }
    limit = Number(raw);
  }
  let after = '';
  if (params.cursor !== undefined) {
    if (typeof params.cursor !== 'string'
      || !/^[A-Za-z0-9_-]{1,512}$/.test(params.cursor)) {
      invalidPage('Некорректный cursor.');
    }
    const decoded = Buffer.from(params.cursor, 'base64url').toString('utf8');
    if (!IDENTIFIER.test(decoded)
      || Buffer.from(decoded, 'utf8').toString('base64url') !== params.cursor) {
      invalidPage('Некорректный cursor.');
    }
    after = decoded;
  }
  return { limit, after };
}
