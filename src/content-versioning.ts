import { db, id, nowIso } from './db.js';
import type { MediaRow } from './media.js';

export const EDITABLE_POST_STATUSES = new Set(['DRAFT', 'READY', 'FAILED']);

export class ContentConflictError extends Error {}
export class ContentImmutableError extends Error {}
export class ContentNotFoundError extends Error {}

export type RevisionTargetSnapshot = {
  targetId: string;
  accountId: string;
  enabled: boolean;
  overrideText: string | null;
};

export type ContentRevisionRow = {
  id: string;
  post_id: string;
  content_version: number;
  title: string;
  body: string;
  schedule_mode: 'MANUAL' | 'AT' | 'QUEUE';
  scheduled_at: string | null;
  targets_json: string;
  media_json: string;
  actor_source: string;
  created_at: string;
};
type VersionedPostRow = {
  id: string;
  status: string;
  editorial_stage: string;
  content_version: number;
  ready_revision_id: string | null;
  title: string;
  body: string;
  schedule_mode: 'MANUAL' | 'AT' | 'QUEUE';
  scheduled_at: string | null;
};

function getPost(postId: string): VersionedPostRow {
  const row = db.prepare(`SELECT id,status,editorial_stage,content_version,ready_revision_id,
      title,body,schedule_mode,scheduled_at FROM posts WHERE id=?`).get(postId) as VersionedPostRow | undefined;
  if (!row) throw new ContentNotFoundError('Пост не найден');
  return row;
}

function ensureEditable(row: VersionedPostRow): void {
  if (!EDITABLE_POST_STATUSES.has(row.status)) {
    throw new ContentImmutableError('Нельзя редактировать пост после начала публикации');
  }
}

export function assertContentVersion(postId: string, expectedContentVersion: number): void {
  const row = getPost(postId);
  ensureEditable(row);
  if (row.content_version !== expectedContentVersion) {
    throw new ContentConflictError(`Версия поста изменилась: ожидалась ${expectedContentVersion}, текущая ${row.content_version}`);
  }
}

export function commitContentEdit<T>(
  postId: string,
  expectedContentVersion: number,
  mutate: () => T
): { contentVersion: number; value: T } {
  const transaction = db.transaction(() => {
    assertContentVersion(postId, expectedContentVersion);
    const value = mutate();
    const updated = db.prepare(`UPDATE posts
      SET content_version=content_version+1,
          ready_revision_id=NULL,
          status='DRAFT',
          editorial_stage='DRAFT',
          updated_at=?
      WHERE id=? AND content_version=? AND status IN ('DRAFT','READY','FAILED')`)
      .run(nowIso(), postId, expectedContentVersion);
    if (updated.changes !== 1) {
      throw new ContentConflictError(`Версия поста ${expectedContentVersion} больше не актуальна`);
    }
    return { contentVersion: expectedContentVersion + 1, value };
  });
  return transaction();
}

export function revisionTargets(revision: ContentRevisionRow): RevisionTargetSnapshot[] {
  return JSON.parse(revision.targets_json) as RevisionTargetSnapshot[];
}

export function revisionMedia(revision: ContentRevisionRow): MediaRow[] {
  return JSON.parse(revision.media_json) as MediaRow[];
}

export function getContentRevision(revisionId: string): ContentRevisionRow {
  const row = db.prepare('SELECT * FROM content_revisions WHERE id=?').get(revisionId) as ContentRevisionRow | undefined;
  if (!row) throw new Error('ContentRevision не найдена');
  return row;
}

export function snapshotContentRevision(
  postId: string,
  expectedContentVersion: number,
  actorSource = 'manual'
): ContentRevisionRow {
  const post = getPost(postId);
  ensureEditable(post);
  if (post.content_version !== expectedContentVersion) {
    throw new ContentConflictError(`Версия поста изменилась: ожидалась ${expectedContentVersion}, текущая ${post.content_version}`);
  }

  const targets = db.prepare(`SELECT id AS targetId, account_id AS accountId, enabled,
      override_text AS overrideText
    FROM post_targets WHERE post_id=? ORDER BY rowid`).all(postId) as Array<{
      targetId: string;
      accountId: string;
      enabled: number;
      overrideText: string | null;
    }>;
  const targetSnapshot: RevisionTargetSnapshot[] = targets.map((target) => ({
    targetId: target.targetId,
    accountId: target.accountId,
    enabled: Boolean(target.enabled),
    overrideText: target.overrideText
  }));
  const media = db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order,created_at').all(postId) as MediaRow[];
  const targetsJson = JSON.stringify(targetSnapshot);
  const mediaJson = JSON.stringify(media);

  const existing = db.prepare('SELECT * FROM content_revisions WHERE post_id=? AND content_version=?')
    .get(postId, expectedContentVersion) as ContentRevisionRow | undefined;
  if (existing) {
    const matches = existing.title === post.title
      && existing.body === post.body
      && existing.schedule_mode === post.schedule_mode
      && existing.scheduled_at === post.scheduled_at
      && existing.targets_json === targetsJson
      && existing.media_json === mediaJson;
    if (!matches) {
      throw new Error('ContentVersion invariant нарушен: существующая revision не совпадает с working content');
    }
    return existing;
  }

  const revisionId = id('rev');
  db.prepare(`INSERT INTO content_revisions
    (id,post_id,content_version,title,body,schedule_mode,scheduled_at,targets_json,media_json,actor_source,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      revisionId,
      postId,
      expectedContentVersion,
      post.title,
      post.body,
      post.schedule_mode,
      post.scheduled_at,
      targetsJson,
      mediaJson,
      actorSource,
      nowIso()
    );
  return getContentRevision(revisionId);
}

export function markReadyRevision(
  postId: string,
  expectedContentVersion: number,
  revisionId: string
): void {
  const updated = db.prepare(`UPDATE posts
    SET status='READY', editorial_stage='APPROVED', ready_revision_id=?, updated_at=?
    WHERE id=?
      AND content_version=?
      AND status IN ('DRAFT','READY','FAILED')
      AND EXISTS (
        SELECT 1 FROM content_revisions cr
        WHERE cr.id=? AND cr.post_id=posts.id AND cr.content_version=posts.content_version
      )`)
    .run(revisionId, nowIso(), postId, expectedContentVersion, revisionId);

  if (updated.changes !== 1) {
    const fresh = getPost(postId);
    ensureEditable(fresh);
    throw new ContentConflictError(`READY не применён: версия ${expectedContentVersion} устарела, текущая ${fresh.content_version}`);
  }
}
