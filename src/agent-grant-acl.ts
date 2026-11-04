/**
 * AGENT-A1b2a execution-time policy primitive, deliberately NOT an HTTP
 * authenticator. A future machine-key/OAuth layer must prove the credential,
 * bind the agent id and token version, then call this policy guard inside
 * its SQLite operation claim before any side effect.
 */
import { db } from './db.js';
import { AgentRegistryError } from './agent-registry-error.js';
import type { AgentScope } from './agent-grant-policy.js';

export type AuthenticatedAgentClaim = {
  agentId: string;
  tokenVersion: number;
  grantVersion: number;
  tokenScopes: readonly string[];
  requiredScope: AgentScope;
  projectId?: string;
  accountId?: string;
  sourceConnectorId?: string;
  postId?: string;
  targetId?: string;
  mediaId?: string;
};

function denied(): never {
  throw new AgentRegistryError('RESOURCE_DENIED',
    'Ресурс или операция недоступны.', 403);
}

function has(list: string[], id: string | undefined): boolean {
  return typeof id === 'string' && list.includes(id);
}

function active(expiry: string | null): boolean {
  return expiry === null || (Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) > Date.now());
}

/** Require authenticated credential versions, scope and every exact resource. */
export function assertEffectiveAgentGrant(claim: AuthenticatedAgentClaim): {
  agentId: string; tokenVersion: number; grantVersion: number;
} {
  if (!Number.isSafeInteger(claim.tokenVersion) || claim.tokenVersion < 1
    || !Number.isSafeInteger(claim.grantVersion) || claim.grantVersion < 1
    || !Array.isArray(claim.tokenScopes)
    || !claim.tokenScopes.includes(claim.requiredScope)) denied();

  // Safe to invoke inside an outer immediate SQLite transaction: SQLite
  // nested operations run against the caller's same connection/snapshot.
  const p = db.prepare([
    'SELECT p.id,p.status,p.token_version,p.expires_at AS principal_expires_at,',
    'g.grant_version,g.expires_at AS grant_expires_at,g.publish_mode,',
    'g.scope_ids_json,g.project_ids_json,g.account_ids_json,',
    'g.source_connector_ids_json',
    'FROM agent_principals p JOIN agent_grants g ON g.agent_id=p.id',
    'WHERE p.id=?'
  ].join(' ')).get(claim.agentId) as {
    id: string; status: string; token_version: number;
    principal_expires_at: string | null; grant_expires_at: string | null;
    grant_version: number; publish_mode: string; scope_ids_json: string;
    project_ids_json: string; account_ids_json: string;
    source_connector_ids_json: string;
  } | undefined;

  if (!p || p.status !== 'ACTIVE' || p.token_version !== claim.tokenVersion
    || p.grant_version !== claim.grantVersion
    || !active(p.principal_expires_at) || !active(p.grant_expires_at)) denied();

  const scopes = JSON.parse(p.scope_ids_json) as string[];
  const projects = JSON.parse(p.project_ids_json) as string[];
  const accounts = JSON.parse(p.account_ids_json) as string[];
  const sources = JSON.parse(p.source_connector_ids_json) as string[];
  if (!scopes.includes(claim.requiredScope)) denied();
  // Scope existence alone is never sufficient for an unbounded list/lookup.
  // Request handlers must provide a specific selected resource, or explicitly
  // filter lists using separate SQL queries scoped by these exact allowlists.
  if (claim.requiredScope === 'projects:read' && !claim.projectId) denied();
  if (claim.requiredScope === 'accounts:read' && !claim.accountId) denied();
  if (claim.requiredScope === 'sources:read' && !claim.sourceConnectorId) denied();
  if (claim.requiredScope === 'media:read'
    && !claim.mediaId && !claim.postId) denied();
  if (claim.requiredScope === 'media:import'
    && (!claim.sourceConnectorId || !claim.projectId)) denied();
  if (claim.requiredScope === 'posts:read'
    && !claim.postId && !claim.projectId && !claim.targetId) denied();
  if (claim.requiredScope === 'posts:write'
    && !claim.postId && !(claim.projectId && claim.accountId)) denied();
  if (claim.requiredScope === 'posts:preview' && !claim.postId) denied();
  if (claim.requiredScope === 'approval:request' && !claim.postId) denied();
  // Jobs and events need an actor-scoped identifier model from A2; do not
  // allow their current broad scopes to expose unrelated agent activity.
  if (claim.requiredScope === 'jobs:read'
    || claim.requiredScope === 'events:read') denied();

  // This stage has no immutable owner consent, scheduler quota or provider
  // execution claim. Never advertise publish/schedule as executable here.
  // A5b must replace this deny with its separate server-side consent+claim
  // gate; storing such scopes is NOT authority for a real provider POST.
  if (claim.requiredScope === 'publish:request'
    || claim.requiredScope === 'schedule:write') denied();

  function exists(table: 'projects' | 'social_accounts' | 'ingestion_connectors', id: string): boolean {
    return Boolean(db.prepare('SELECT 1 FROM ' + table + ' WHERE id=?').get(id));
  }
  if (claim.projectId !== undefined
    && (!has(projects, claim.projectId) || !exists('projects', claim.projectId))) denied();
  if (claim.accountId !== undefined
    && (!has(accounts, claim.accountId) || !exists('social_accounts', claim.accountId))) denied();
  if (claim.sourceConnectorId !== undefined
    && (!has(sources, claim.sourceConnectorId)
      || !exists('ingestion_connectors', claim.sourceConnectorId))) denied();

  let actualPost: string | undefined;
  if (claim.targetId !== undefined) {
    const target = db.prepare([
      'SELECT t.post_id,t.account_id FROM post_targets t WHERE t.id=?'
    ].join(' ')).get(claim.targetId) as {
      post_id: string; account_id: string;
    } | undefined;
    if (!target || !has(accounts, target.account_id)
      || (claim.accountId !== undefined && claim.accountId !== target.account_id)) denied();
    actualPost = target.post_id;
  }
  if (claim.mediaId !== undefined) {
    const media = db.prepare('SELECT post_id FROM media WHERE id=?')
      .get(claim.mediaId) as { post_id: string } | undefined;
    if (!media || (actualPost !== undefined && actualPost !== media.post_id)) denied();
    actualPost = media.post_id;
  }
  if (claim.postId !== undefined && actualPost !== undefined
    && claim.postId !== actualPost) denied();
  const postId = claim.postId ?? actualPost;
  if (postId !== undefined) {
    const post = db.prepare('SELECT project_id FROM posts WHERE id=?')
      .get(postId) as { project_id: string } | undefined;
    if (!post || !has(projects, post.project_id)
      || (claim.projectId !== undefined && post.project_id !== claim.projectId)) denied();
    // A full post response might include target metadata: if ANY target on the
    // saved post lies outside the allowlist, refuse access to that whole post.
    // Future list/summary DTOs can offer target-redacted views separately.
    const targetAccounts = db.prepare('SELECT account_id FROM post_targets WHERE post_id=?')
      .all(postId) as Array<{ account_id: string }>;
    if (targetAccounts.some(t => !has(accounts, t.account_id))) denied();
  }

  return {
    agentId: p.id,
    tokenVersion: p.token_version,
    grantVersion: p.grant_version
  };
}
