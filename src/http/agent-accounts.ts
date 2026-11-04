import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, id } from '../db.js';
import { getOwnerAgent } from '../agent-owner-registry.js';
import { AgentRegistryError } from '../agent-registry-error.js';
import { assertEffectiveAgentGrant } from '../agent-grant-acl.js';
import { readCapabilityProfile, type PublicationFormat } from '../social-credential-capability.js';
import { parsePage, IDENTIFIER, type Page } from './agent-page.js';
import {
  AgentBearerFailure, respondAgentBearerFailure, verifiedAgentBearer
} from './agent-bearer-boundary.js';

type Platform = 'telegram' | 'vk' | 'max' | 'instagram';
type SourceFormat = PublicationFormat;
type PublicFormat = 'TEXT_ONLY' | 'IMAGE' | 'CAROUSEL' | 'VIDEO' | 'VERTICAL_VIDEO' | 'STORY_SEQUENCE';
type PublicState = 'READY' | 'BLOCKED' | 'UNKNOWN';

const FORMAT_MAP: ReadonlyArray<readonly [PublicFormat, SourceFormat]> = [
  ['TEXT_ONLY', 'TEXT'],
  ['IMAGE', 'IMAGE'],
  ['CAROUSEL', 'CAROUSEL'],
  ['VIDEO', 'VIDEO'],
  ['VERTICAL_VIDEO', 'SHORT'],
  ['STORY_SEQUENCE', 'STORY']
];
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const KNOWN_PLATFORM: ReadonlySet<string> =
  new Set(['telegram', 'vk', 'max', 'instagram']);

type AccountRow = {
  id: string; name: string; platform: string; enabled: number;
};

function safeReason(input: unknown, fallback: string): string {
  if (typeof input !== 'string' || !SAFE_CODE.test(input)) return fallback;
  return input;
}

/**
 * Never infer capability from enabled, saved credentials, generic platform
 * support or a stale profile. This safe projection consumes only the canonical
 * credential-version-bound server profile, never provider secrets.
 */
function publicCapability(row: AccountRow) {
  const profile = readCapabilityProfile(row.id);
  const verified = profile.profileCurrent && profile.lastCheckStatus === 'SUCCESS'
    && profile.semantic?.credential.validity === 'CONFIRMED';
  const formats = FORMAT_MAP.map(([format, source]) => {
    const evidence = verified ? profile.semantic?.publicationReadiness[source] : undefined;
    let state: PublicState = 'UNKNOWN';
    let reasonCode: string | undefined;
    if (!row.enabled) {
      state = 'BLOCKED';
      reasonCode = 'ACCOUNT_DISABLED';
    } else if (!verified) {
      state = 'UNKNOWN';
      reasonCode = 'CAPABILITY_NOT_VERIFIED';
    } else if (evidence?.state === 'READY') {
      state = 'READY';
    } else if (evidence?.state === 'BLOCKED' || evidence?.state === 'SETUP_REQUIRED'
      || evidence?.state === 'NOT_IMPLEMENTED') {
      state = 'BLOCKED';
      reasonCode = safeReason(evidence.remediationCodes[0],
        evidence.state === 'SETUP_REQUIRED' ? 'SETUP_REQUIRED' : 'FORMAT_NOT_AVAILABLE');
    } else {
      state = 'UNKNOWN';
      reasonCode = evidence?.state === 'UNAVAILABLE'
        ? 'CAPABILITY_UNAVAILABLE' : 'CAPABILITY_NOT_VERIFIED';
    }
    return {
      format, state,
      ...(reasonCode ? { reasonCode } : {})
    };
  });
  return { verified: Boolean(verified), formats };
}

function listVerifiedAccounts(request: FastifyRequest, page: Page) {
  return db.transaction(() => {
    // Both token and principal/grant revalidated for every read.
    const principal = verifiedAgentBearer(request);
    const grant = getOwnerAgent(principal.agentId).grant;
    if (grant.status !== 'ACTIVE' || principal.grantVersion !== grant.grantVersion) {
      throw new AgentBearerFailure(401, 'UNAUTHORIZED', 'Разрешения агента устарели.');
    }
    if (!principal.tokenScopes.includes('accounts:read')
      || !grant.scopeIds.includes('accounts:read')) {
      throw new AgentRegistryError('FORBIDDEN_SCOPE',
        'Недостаточно прав для просмотра аккаунтов.', 403);
    }
    const allowlist = [...new Set(grant.accountIds.filter(value => IDENTIFIER.test(value)))];
    if (!allowlist.length) {
      return { items: [], pagination: { limit: page.limit, nextCursor: null } };
    }

    // SQL filters IDs before returning rows. A client never receives a broad
    // social_accounts result containing credentials_encrypted or metadata
    // about non-allowlisted accounts.
    const sql = [
      'SELECT id,name,platform,enabled FROM social_accounts',
      'WHERE id IN (' + allowlist.map(() => '?').join(',') + ') AND id>?',
      'ORDER BY id LIMIT ?'
    ].join(' ');
    const rows = db.prepare(sql).all(...allowlist, page.after, page.limit + 1) as AccountRow[];
    const visible = rows.slice(0, page.limit);
    for (const account of visible) {
      assertEffectiveAgentGrant({
        agentId: principal.agentId,
        tokenVersion: principal.tokenVersion,
        grantVersion: principal.grantVersion,
        tokenScopes: principal.tokenScopes,
        requiredScope: 'accounts:read', accountId: account.id
      });
      if (!KNOWN_PLATFORM.has(account.platform)) {
        throw new AgentRegistryError('RESOURCE_DENIED',
          'Недопустимый тип аккаунта.', 403);
      }
    }
    return {
      items: visible.map(account => ({
        id: account.id,
        platform: account.platform as Platform,
        name: account.name.slice(0, 160),
        enabled: account.enabled === 1,
        capability: publicCapability(account)
      })),
      pagination: {
        limit: page.limit,
        nextCursor: rows.length > page.limit
          ? Buffer.from(visible.at(-1)!.id).toString('base64url') : null
      }
    };
  })();
}
function readError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentRegistryError && (
    error.code === 'VALIDATION_ERROR' || error.code === 'FORBIDDEN_SCOPE'
    || error.code === 'RESOURCE_DENIED'
  )) {
    return reply.code(error.status).send({
      error: { code: error.code, message: error.message },
      requestId: id('req'), retryable: false
    });
  }
  return respondAgentBearerFailure(reply, error);
}

/** A2a2: account metadata + strictly safe capability evidence, no credentials. */
export async function registerAgentAccountReadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/v1/accounts', async (request, reply) => {
    try {
      return listVerifiedAccounts(request, parsePage(request.query));
    } catch (error) {
      return readError(reply, error);
    }
  });
}
