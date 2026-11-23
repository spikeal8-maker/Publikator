import { db } from '../db.js';
import { assertEffectiveAgentGrant, type VerifiedAgentIdentity } from '../agent-grant-acl.js';
import { getOwnerAgent } from '../agent-owner-registry.js';
import { AgentRegistryError } from '../agent-registry-error.js';
import type { Page } from './agent-page.js';

const visiblePosts = `SELECT p.* FROM posts p
  WHERE p.project_id=@projectId
    AND COALESCE(p.editorial_stage,'DRAFT') NOT IN ('ARCHIVED','TRASHED')
    AND NOT EXISTS (
      SELECT 1 FROM post_targets t
      WHERE t.post_id=p.id
        AND t.account_id NOT IN (SELECT value FROM json_each(@accountIds))
    )`;

const summaryFields = `p.id AS postId, p.project_id AS projectId, p.title,
  p.status, COALESCE(p.editorial_stage,'DRAFT') AS editorialStage,
  p.content_format AS contentFormat, p.publication_kind AS publicationKind,
  p.content_version AS contentVersion, p.schedule_mode AS scheduleMode,
  p.scheduled_at_utc AS scheduledAtUtc, p.schedule_timezone AS scheduleTimezone,
  p.updated_at AS updatedAt`;

function readProject<T>(
  identity: VerifiedAgentIdentity,
  projectId: string,
  read: (params: { projectId: string; accountIds: string }) => T,
): T {
  return db.transaction(() => {
    assertEffectiveAgentGrant({ ...identity, projectId, requiredScope: 'posts:read' });
    const { grant } = getOwnerAgent(identity.agentId);
    return read({ projectId, accountIds: JSON.stringify(grant.accountIds) });
  })();
}

export function listScopedPublications(identity: VerifiedAgentIdentity, projectId: string, page: Page) {
  return readProject(identity, projectId, (params) => {
    const rows = db.prepare(`WITH visible AS (${visiblePosts})
      SELECT ${summaryFields} FROM visible p
      WHERE p.id > @after ORDER BY p.id LIMIT @limit`)
      .all({ ...params, after: page.after, limit: page.limit + 1 }) as Array<{ postId: string }>;
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items,
      pagination: {
        limit: page.limit,
        nextCursor: rows.length > page.limit && last
          ? Buffer.from(last.postId).toString('base64url') : null,
      },
    };
  });
}

export function getScopedPublication(identity: VerifiedAgentIdentity, projectId: string, postId: string) {
  return readProject(identity, projectId, (params) => {
    const publication = db.prepare(`WITH visible AS (${visiblePosts})
      SELECT ${summaryFields}, p.body AS bodyPlain FROM visible p WHERE p.id=@postId`)
      .get({ ...params, postId }) as { bodyPlain: string } | undefined;
    if (!publication) {
      throw new AgentRegistryError('RESOURCE_DENIED', 'Публикация недоступна.', 403);
    }
    const targets = db.prepare(`SELECT t.account_id AS accountId, a.platform, t.state,
      t.enabled = 1 AS enabled FROM post_targets t JOIN social_accounts a ON a.id=t.account_id
      WHERE t.post_id=? ORDER BY t.account_id`).all(postId) as Array<{
        accountId: string; platform: string; state: string; enabled: number;
      }>;
    const media = db.prepare(`SELECT cm.media_id AS mediaId, cm.role, cm.sort_order AS sortOrder
      FROM content_media cm WHERE cm.post_id=? ORDER BY cm.sort_order, cm.created_at, cm.media_id`).all(postId);
    return {
      ...publication,
      targets: targets.map((target) => ({ ...target, enabled: target.enabled === 1 })),
      media,
    };
  });
}

export function getScopedPublicationAnalytics(identity: VerifiedAgentIdentity, projectId: string) {
  return readProject(identity, projectId, (params) => {
    const publications = db.prepare(`WITH visible AS (${visiblePosts})
      SELECT status, COALESCE(editorial_stage,'DRAFT') AS editorialStage, schedule_mode AS scheduleMode,
        COUNT(*) AS count FROM visible
      GROUP BY status, editorialStage, scheduleMode ORDER BY status, editorialStage, scheduleMode`)
      .all(params) as Array<{ status: string; editorialStage: string; scheduleMode: string; count: number }>;
    const deliveries = db.prepare(`WITH visible AS (${visiblePosts})
      SELECT a.platform, t.state, COUNT(*) AS count FROM visible p
      JOIN post_targets t ON t.post_id=p.id JOIN social_accounts a ON a.id=t.account_id
      WHERE t.enabled=1 GROUP BY a.platform, t.state ORDER BY a.platform, t.state`).all(params);
    return {
      projectId,
      totalPublications: publications.reduce((total, row) => total + row.count, 0),
      publications,
      deliveries,
    };
  });
}
