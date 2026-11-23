import { createHash } from 'node:crypto';
import { assertEffectiveAgentGrant, type VerifiedAgentIdentity } from './agent-grant-acl.js';
import { AgentRegistryError } from './agent-registry-error.js';
import { revisionTargets, snapshotContentRevision } from './content-versioning.js';
import { db, id, nowIso } from './db.js';
import { preflightRevision } from './publisher.js';
import { resolveExactSchedule } from './schedule-time.js';
import { readCapabilityProfile, type PublicationFormat } from './social-credential-capability.js';

type Request = {
  postId: string;
  expectedContentVersion: number;
  targetAccountIds: string[];
  idempotencyKey: string;
  when: { mode: 'NOW' } | { mode: 'AT'; scheduledAt: string; timezone: string };
};
type Preflight = {
  ok: boolean;
  issues: Array<{ accountId: string; code: string; severity: 'error' | 'warning' }>;
};
type IntentRow = {
  id: string; post_id: string; revision_id: string; content_version: number; target_ids_json: string;
  mode: 'NOW' | 'AT'; scheduled_at_utc: string | null; schedule_timezone: string | null;
  grant_version: number; token_version: number; request_hash: string; preflight_json: string;
  created_at: string; expires_at: string;
};

function deny(code: string, message: string, status: number): never {
  throw new AgentRegistryError(code, message, status);
}

const hash = (values: unknown) => createHash('sha256').update(JSON.stringify(values)).digest('hex');

function describe(row: IntentRow) {
  return {
    intentId: row.id, postId: row.post_id, revisionId: row.revision_id,
    contentVersion: row.content_version, status: 'WAITING_APPROVAL',
    targetAccountIds: JSON.parse(row.target_ids_json) as string[],
    mode: row.mode, scheduledAtUtc: row.scheduled_at_utc, scheduleTimezone: row.schedule_timezone,
    preflight: JSON.parse(row.preflight_json) as Preflight, createdAt: row.created_at, expiresAt: row.expires_at,
  };
}

export function requestAgentPublication(identity: VerifiedAgentIdentity, input: Request) {
  const accounts = [...new Set(input.targetAccountIds)].sort();
  if (!accounts.length || accounts.length !== input.targetAccountIds.length) {
    deny('VALIDATION_ERROR', 'Перечислите каждый выбранный аккаунт один раз.', 400);
  }
  let scheduledAtUtc: string | null = null;
  let scheduleTimezone: string | null = null;
  if (input.when.mode === 'AT') {
    try {
      ({ scheduledAtUtc, scheduleTimezone } = resolveExactSchedule(input.when.scheduledAt, input.when.timezone));
    } catch {
      deny('VALIDATION_ERROR', 'Укажите точное время с UTC-смещением и часовой пояс IANA.', 400);
    }
  }

  return db.transaction(() => {
    const { postId, expectedContentVersion } = input;
    assertEffectiveAgentGrant({ ...identity, postId, requiredScope: 'approval:request' });
    const post = db.prepare(`SELECT p.project_id AS projectId,p.content_version AS version,
        g.publish_mode AS publishMode, a.expires_at AS agentExpiresAt, g.expires_at AS grantExpiresAt
      FROM posts p JOIN agent_draft_ownership o ON o.post_id=p.id
      JOIN agent_grants g ON g.agent_id=o.agent_id JOIN agent_principals a ON a.id=o.agent_id
      WHERE p.id=? AND o.agent_id=? AND p.status='DRAFT' AND p.schedule_mode='MANUAL'
        AND p.editorial_stage IN ('IDEA','DRAFT','IN_REVIEW')`).get(postId, identity.agentId) as {
        projectId: string; version: number; publishMode: string;
        agentExpiresAt: string | null; grantExpiresAt: string | null;
      } | undefined;
    if (post?.publishMode !== 'OWNER_APPROVAL') {
      return deny('POLICY_DENIED', 'Для этого черновика не разрешены запросы на подтверждение отправки.', 403);
    }
    const requestHash = hash([postId, expectedContentVersion, accounts, input.when.mode, scheduledAtUtc, scheduleTimezone]);
    const key = hash([identity.agentId, 'request_publication', input.idempotencyKey]);
    const prior = db.prepare('SELECT * FROM agent_publication_intents WHERE agent_id=? AND idempotency_hash=?')
      .get(identity.agentId, key) as IntentRow | undefined;
    if (prior) {
      if (prior.request_hash !== requestHash) return deny('IDEMPOTENCY_CONFLICT', 'Ключ уже использован для другого запроса.', 409);
      if (prior.grant_version !== identity.grantVersion || prior.token_version !== identity.tokenVersion
        || prior.expires_at <= nowIso()) return deny('APPROVAL_STALE', 'Запрос устарел. Подготовьте новый.', 409);
      return describe(prior);
    }
    if (post.version !== expectedContentVersion) {
      return deny('CONTENT_VERSION_CONFLICT', 'Версия черновика изменилась.', 409);
    }
    const stamp = nowIso();
    if (scheduledAtUtc && scheduledAtUtc <= stamp) {
      return deny('VALIDATION_ERROR', 'Для отложенной отправки выберите время в будущем.', 400);
    }
    const revision = snapshotContentRevision(postId, expectedContentVersion, 'agent_api');
    const targets = revisionTargets(revision).filter((target) => target.enabled);
    if (hash(accounts) !== hash(targets.map((target) => target.accountId).sort())) {
      return deny('TARGETS_MISMATCH', 'Список аккаунтов должен совпадать с получателями версии.', 409);
    }
    const validation = preflightRevision(revision.id);
    const issues: Preflight['issues'] = validation.issues.map(({ accountId, code, severity }) =>
      ({ accountId, code: code ?? 'FORMAT_PREFLIGHT', severity }));
    const destinations = targets.map((target) => {
      const account = db.prepare('SELECT platform,enabled,credential_version,credentials_encrypted FROM social_accounts WHERE id=?')
        .get(target.accountId);
      const profile = readCapabilityProfile(target.accountId);
      const kind = target.rendition?.publicationKind ?? revision.publication_kind;
      const contentFormat = target.rendition?.contentFormat ?? revision.content_format;
      const format = (kind === 'FEED' ? contentFormat === 'TEXT_ONLY' ? 'TEXT' : contentFormat : kind) as PublicationFormat;
      if (profile.semantic?.publicationReadiness[format]?.state !== 'READY') {
        issues.push({ accountId: target.accountId, code: 'ACCOUNT_FORMAT_NOT_CONFIRMED', severity: 'error' });
      }
      return [target.targetId, target.accountId, account, profile.profileFingerprint];
    });
    const expiresAt = new Date(Math.min(Date.parse(stamp) + 24 * 60 * 60 * 1000,
      ...(scheduledAtUtc ? [Date.parse(scheduledAtUtc)] : []),
      ...(post.agentExpiresAt ? [Date.parse(post.agentExpiresAt)] : []),
      ...(post.grantExpiresAt ? [Date.parse(post.grantExpiresAt)] : []))).toISOString();
    const newId = id('intent');
    const targetJson = JSON.stringify(accounts);
    const preflight = JSON.stringify({ ok: !issues.some((issue) => issue.severity === 'error'), issues });
    db.prepare(`INSERT INTO agent_publication_intents
      (id,agent_id,post_id,revision_id,content_version,grant_version,token_version,idempotency_hash,request_hash,
       content_digest,destinations_digest,target_ids_json,mode,scheduled_at_utc,schedule_timezone,preflight_json,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      newId, identity.agentId, postId, revision.id, expectedContentVersion, identity.grantVersion,
      identity.tokenVersion, key, requestHash, hash(revision), hash(destinations), targetJson,
      input.when.mode, scheduledAtUtc, scheduleTimezone, preflight, stamp, expiresAt,
    );
    db.prepare(`INSERT INTO agent_activity_events (event_id,agent_id,actor_type,origin,request_id,
      operation_id,post_id,project_id,target_account_ids_json,publication_intent_id,grant_version,stage,outcome,safe_summary,occurred_at)
      VALUES (?,?,'AGENT','MCP',?,'request_publication',?,?,?,?,?,'WAITING_APPROVAL','PENDING',?,?)`).run(
      id('evt'), identity.agentId, 'req_' + key, postId, post.projectId, targetJson, newId, identity.grantVersion,
      'Подготовлен запрос, требуется решение владельца.', stamp,
    );
    return describe(db.prepare('SELECT * FROM agent_publication_intents WHERE id=?').get(newId) as IntentRow);
  }).immediate();
}
