import { db, event } from './db.js';
import { markReadyRevision, snapshotContentRevision } from './content-versioning.js';
import { preflightRevision } from './publisher.js';

export type GoogleSheetsAutoReadyResult = {
  postId: string;
  outcome: 'ready' | 'blocked' | 'skipped';
  revisionId: string | null;
  reason: string | null;
  issues: Array<{ platform: string; accountName: string; message: string }>;
};

function blocked(postId: string, reason: string, issues: GoogleSheetsAutoReadyResult['issues'] = []): GoogleSheetsAutoReadyResult {
  event({
    postId,
    level: 'warning',
    type: 'google_sheets.auto_ready_blocked',
    message: reason,
    data: { issues }
  });
  return { postId, outcome: 'blocked', revisionId: null, reason, issues };
}
export function autoReadyGoogleSheetsPost(postId: string): GoogleSheetsAutoReadyResult {
  const post = db.prepare(`SELECT id,status,editorial_stage,content_version,imported_content_version,source_type
    FROM posts WHERE id=?`).get(postId) as {
      id: string; status: string; editorial_stage: string; content_version: number;
      imported_content_version: number | null; source_type: string | null;
    } | undefined;
  if (!post) return blocked(postId, 'Auto Ready blocked: post not found');
  if (post.source_type !== 'google_sheets') return blocked(postId, 'Auto Ready blocked: post is not Google Sheets-owned');
  if (post.status !== 'DRAFT' || post.editorial_stage !== 'DRAFT') {
    return { postId, outcome: 'skipped', revisionId: null, reason: `status=${post.status}, editorial=${post.editorial_stage}`, issues: [] };
  }
  if (post.imported_content_version == null || post.imported_content_version !== post.content_version) {
    return blocked(postId, 'Auto Ready blocked: working content diverged from the imported version');
  }

  const mediaCount = (db.prepare('SELECT COUNT(*) AS count FROM media WHERE post_id=?').get(postId) as { count: number }).count;
  if (mediaCount < 1) return blocked(postId, 'Auto Ready blocked: publication has no media');
  const targetCount = (db.prepare(`SELECT COUNT(*) AS count FROM post_targets pt
    JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.post_id=? AND pt.enabled=1 AND a.enabled=1`).get(postId) as { count: number }).count;
  if (targetCount < 1) return blocked(postId, 'Auto Ready blocked: no enabled publication target');

  try {
    const revision = snapshotContentRevision(postId, post.content_version, 'google-sheets-auto-ready');
    const preflight = preflightRevision(revision.id);
    if (!preflight.ok) {
      const issues = preflight.issues.map((issue) => ({
        platform: issue.platform,
        accountName: issue.accountName,
        message: issue.message
      }));
      return blocked(postId, 'Auto Ready blocked: platform preflight failed', issues);
    }

    markReadyRevision(postId, post.content_version, revision.id);
    event({
      postId,
      type: 'google_sheets.auto_ready_succeeded',
      message: 'Google Sheets trusted-source content passed Auto Ready gate',
      data: { revisionId: revision.id, contentVersion: post.content_version }
    });
    return { postId, outcome: 'ready', revisionId: revision.id, reason: null, issues: [] };
  } catch (error) {
    return blocked(postId, `Auto Ready blocked: ${error instanceof Error ? error.message : String(error)}`);
  }
}
