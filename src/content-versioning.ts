import { db, id, nowIso } from './db.js';
import type { EditorialStage } from './domain/content-domain.js';
import type { MediaRow } from './media.js';

export const EDITABLE_POST_STATUSES = new Set(['DRAFT', 'READY', 'FAILED']);

export type RevisionActorSource =
  | 'manual'
  | 'manual_restore'
  | 'content_plan'
  | 'google_sheets'
  | 'system'
  | 'migration';

export class ContentConflictError extends Error {}
export class ContentImmutableError extends Error {}
export class ContentNotFoundError extends Error {}

export type RevisionTargetRenditionSnapshot = {
  textRichJson: string | null;
  textPlain: string | null;
  publicationKind: string | null;
  contentFormat: string | null;
  mediaPlanJson: string | null;
  optionsJson: string | null;
};

export type RevisionTargetSnapshot = {
  targetId: string;
  accountId: string;
  enabled: boolean;
  overrideText: string | null;
  rendition: RevisionTargetRenditionSnapshot | null;
};

export type RevisionContentMediaSnapshot = {
  mediaId: string | null;
  sortOrder: number;
  role: string;
  previewDurationMs: number | null;
};

export type ContentRevisionRow = {
  id: string;
  post_id: string;
  content_version: number;
  title: string;
  body: string;
  editorial_stage: EditorialStage;
  schedule_mode: 'MANUAL' | 'AT' | 'QUEUE';
  scheduled_at: string | null;
  scheduled_at_utc: string | null;
  schedule_timezone: string | null;
  publication_kind: 'FEED' | 'SHORT' | 'STORY';
  content_format: string;
  targets_json: string;
  media_json: string;
  content_media_json: string;
  actor_source: string;
  restored_from_revision_id: string | null;
  created_at: string;
};

type VersionedPostRow = {
  id: string;
  status: string;
  editorial_stage: EditorialStage;
  content_version: number;
  ready_revision_id: string | null;
  title: string;
  body: string;
  schedule_mode: 'MANUAL' | 'AT' | 'QUEUE';
  scheduled_at: string | null;
  scheduled_at_utc: string | null;
  schedule_timezone: string | null;
  publication_kind: 'FEED' | 'SHORT' | 'STORY';
  content_format: string;
};

export type ContentEditOutcome = {
  status?: 'DRAFT' | 'READY' | 'FAILED';
  editorialStage?: EditorialStage;
  restoredFromRevisionId?: string | null;
  allowInactive?: boolean;
};

export type WorkingContentSnapshot = {
  postId: string;
  contentVersion: number;
  title: string;
  body: string;
  editorialStage: EditorialStage;
  scheduleMode: 'MANUAL' | 'AT' | 'QUEUE';
  scheduledAt: string | null;
  scheduledAtUtc: string | null;
  scheduleTimezone: string | null;
  publicationKind: 'FEED' | 'SHORT' | 'STORY';
  contentFormat: string;
  targets: RevisionTargetSnapshot[];
  media: MediaRow[];
  contentMedia: RevisionContentMediaSnapshot[];
};

function getPost(postId: string): VersionedPostRow {
  const row = db.prepare(`SELECT id,status,editorial_stage,content_version,ready_revision_id,
      title,body,schedule_mode,scheduled_at,scheduled_at_utc,schedule_timezone,publication_kind,content_format
    FROM posts WHERE id=?`).get(postId) as VersionedPostRow | undefined;
  if (!row) throw new ContentNotFoundError('Пост не найден');
  return row;
}

function ensureEditable(row: VersionedPostRow): void {
  if (row.editorial_stage === 'ARCHIVED' || row.editorial_stage === 'TRASHED') {
    throw new ContentImmutableError('Сначала восстановите пост из архива или корзины');
  }
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

function revisionTargetHasRendition(target: RevisionTargetSnapshot): boolean {
  const rendition = target.rendition;
  return Boolean(rendition && [
    rendition.textRichJson,
    rendition.textPlain,
    rendition.publicationKind,
    rendition.contentFormat,
    rendition.mediaPlanJson,
    rendition.optionsJson
  ].some((value) => value !== null && value !== undefined));
}

export function isMeaningfulRevisionTarget(target: RevisionTargetSnapshot): boolean {
  return Boolean(target.enabled)
    || (target.overrideText !== null && target.overrideText !== undefined)
    || revisionTargetHasRendition(target);
}

export function semanticRevisionTargets(targets: RevisionTargetSnapshot[]): RevisionTargetSnapshot[] {
  return targets.filter(isMeaningfulRevisionTarget);
}

function targetSnapshot(postId: string): RevisionTargetSnapshot[] {
  const targets = db.prepare(`SELECT pt.id AS targetId, pt.account_id AS accountId, pt.enabled,
      pt.override_text AS overrideText, tr.text_rich_json AS renditionTextRichJson, tr.text_plain AS renditionTextPlain,
      tr.publication_kind AS renditionPublicationKind, tr.content_format AS renditionContentFormat,
      tr.media_plan_json AS renditionMediaPlanJson, tr.options_json AS renditionOptionsJson
    FROM post_targets pt LEFT JOIN target_renditions tr ON tr.target_id=pt.id
    WHERE pt.post_id=? ORDER BY pt.rowid`).all(postId) as Array<{
      targetId: string; accountId: string; enabled: number; overrideText: string | null;
      renditionTextRichJson: string | null; renditionTextPlain: string | null; renditionPublicationKind: string | null;
      renditionContentFormat: string | null; renditionMediaPlanJson: string | null; renditionOptionsJson: string | null;
    }>;

  const snapshot = targets.map((target) => {
    const hasRendition = [
      target.renditionTextRichJson,
      target.renditionTextPlain,
      target.renditionPublicationKind,
      target.renditionContentFormat,
      target.renditionMediaPlanJson,
      target.renditionOptionsJson
    ].some((value) => value !== null);
    return {
      targetId: target.targetId,
      accountId: target.accountId,
      enabled: Boolean(target.enabled),
      overrideText: target.overrideText,
      rendition: hasRendition ? {
        textRichJson: target.renditionTextRichJson,
        textPlain: target.renditionTextPlain,
        publicationKind: target.renditionPublicationKind,
        contentFormat: target.renditionContentFormat,
        mediaPlanJson: target.renditionMediaPlanJson,
        optionsJson: target.renditionOptionsJson
      } : null
    };
  });
  return semanticRevisionTargets(snapshot);
}

function contentMediaSnapshot(postId: string): RevisionContentMediaSnapshot[] {
  const rows = db.prepare(`SELECT media_id,sort_order,role,preview_duration_ms
    FROM content_media WHERE post_id=? ORDER BY sort_order,created_at`).all(postId) as Array<{
      media_id: string;
      sort_order: number;
      role: string;
      preview_duration_ms: number | null;
    }>;
  return rows.map((row) => ({
    mediaId: row.media_id,
    sortOrder: row.sort_order,
    role: row.role,
    previewDurationMs: row.preview_duration_ms
  }));
}

export function currentContentSnapshot(postId: string): WorkingContentSnapshot {
  const post = getPost(postId);
  return {
    postId,
    contentVersion: post.content_version,
    title: post.title,
    body: post.body,
    editorialStage: post.editorial_stage,
    scheduleMode: post.schedule_mode,
    scheduledAt: post.scheduled_at,
    scheduledAtUtc: post.scheduled_at_utc,
    scheduleTimezone: post.schedule_timezone,
    publicationKind: post.publication_kind,
    contentFormat: post.content_format,
    targets: targetSnapshot(postId),
    media: db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order,created_at').all(postId) as MediaRow[],
    contentMedia: contentMediaSnapshot(postId)
  };
}

function snapshotCurrentContentRevision(
  postId: string,
  expectedContentVersion: number,
  actorSource: RevisionActorSource,
  restoredFromRevisionId: string | null = null
): ContentRevisionRow {
  const post = getPost(postId);
  if (post.content_version !== expectedContentVersion) {
    throw new ContentConflictError(`Версия поста изменилась: ожидалась ${expectedContentVersion}, текущая ${post.content_version}`);
  }

  if (restoredFromRevisionId) {
    const source = db.prepare('SELECT post_id FROM content_revisions WHERE id=?').get(restoredFromRevisionId) as { post_id: string } | undefined;
    if (!source || source.post_id !== postId) throw new Error('restored_from_revision_id должен принадлежать тому же посту');
  }

  const snapshot = currentContentSnapshot(postId);
  const targetsJson = JSON.stringify(snapshot.targets);
  const mediaJson = JSON.stringify(snapshot.media);
  const contentMediaJson = JSON.stringify(snapshot.contentMedia);

  const existing = db.prepare('SELECT * FROM content_revisions WHERE post_id=? AND content_version=?')
    .get(postId, expectedContentVersion) as ContentRevisionRow | undefined;
  if (existing) {
    const matches = existing.title === post.title
      && existing.body === post.body
      && existing.editorial_stage === post.editorial_stage
      && existing.schedule_mode === post.schedule_mode
      && existing.scheduled_at === post.scheduled_at
      && existing.scheduled_at_utc === post.scheduled_at_utc
      && existing.schedule_timezone === post.schedule_timezone
      && existing.publication_kind === post.publication_kind
      && existing.content_format === post.content_format
      && existing.targets_json === targetsJson
      && existing.media_json === mediaJson
      && existing.content_media_json === contentMediaJson
      && existing.restored_from_revision_id === restoredFromRevisionId;
    if (!matches) {
      throw new Error('ContentVersion invariant нарушен: существующая revision не совпадает с working content');
    }
    return existing;
  }

  const revisionId = id('rev');
  db.prepare(`INSERT INTO content_revisions
    (id,post_id,content_version,title,body,editorial_stage,schedule_mode,scheduled_at,scheduled_at_utc,schedule_timezone,
     publication_kind,content_format,targets_json,media_json,content_media_json,actor_source,restored_from_revision_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      revisionId,
      postId,
      expectedContentVersion,
      post.title,
      post.body,
      post.editorial_stage,
      post.schedule_mode,
      post.scheduled_at,
      post.scheduled_at_utc,
      post.schedule_timezone,
      post.publication_kind,
      post.content_format,
      targetsJson,
      mediaJson,
      contentMediaJson,
      actorSource,
      restoredFromRevisionId,
      nowIso()
    );
  return getContentRevision(revisionId);
}

export function createInitialContentRevision(
  postId: string,
  actorSource: RevisionActorSource
): ContentRevisionRow {
  const transaction = db.transaction(() => {
    const post = getPost(postId);
    if (post.content_version !== 1) {
      throw new Error(`Initial revision requires content_version=1, got ${post.content_version}`);
    }
    return snapshotCurrentContentRevision(postId, 1, actorSource);
  });
  return transaction();
}

export function commitContentEdit<T>(
  postId: string,
  expectedContentVersion: number,
  actorSource: RevisionActorSource,
  mutate: () => T,
  outcome: ContentEditOutcome = {}
): { contentVersion: number; value: T; revision: ContentRevisionRow } {
  const transaction = db.transaction(() => {
    const current = getPost(postId);
    if (!outcome.allowInactive) ensureEditable(current);
    else if (!EDITABLE_POST_STATUSES.has(current.status)) throw new ContentImmutableError('Нельзя менять lifecycle после начала публикации');
    if (current.content_version !== expectedContentVersion) {
      throw new ContentConflictError(`Версия поста изменилась: ожидалась ${expectedContentVersion}, текущая ${current.content_version}`);
    }
    const value = mutate();
    const nextStatus = outcome.status ?? 'DRAFT';
    const nextStage = outcome.editorialStage ?? 'DRAFT';
    const updated = db.prepare(`UPDATE posts
      SET content_version=content_version+1,
          ready_revision_id=NULL,
          status=?,
          editorial_stage=?,
          updated_at=?
      WHERE id=? AND content_version=? AND status IN ('DRAFT','READY','FAILED')`)
      .run(nextStatus, nextStage, nowIso(), postId, expectedContentVersion);
    if (updated.changes !== 1) {
      throw new ContentConflictError(`Версия поста ${expectedContentVersion} больше не актуальна`);
    }
    const contentVersion = expectedContentVersion + 1;
    const revision = snapshotCurrentContentRevision(
      postId,
      contentVersion,
      actorSource,
      outcome.restoredFromRevisionId ?? null
    );
    return { contentVersion, value, revision };
  });
  return transaction();
}

export function revisionTargets(revision: ContentRevisionRow): RevisionTargetSnapshot[] {
  const parsed = JSON.parse(revision.targets_json);
  return Array.isArray(parsed) ? semanticRevisionTargets(parsed as RevisionTargetSnapshot[]) : [];
}

export function revisionContentMedia(revision: ContentRevisionRow): RevisionContentMediaSnapshot[] {
  if (!revision.content_media_json) return [];
  try {
    const parsed = JSON.parse(revision.content_media_json);
    return Array.isArray(parsed) ? parsed as RevisionContentMediaSnapshot[] : [];
  } catch {
    return [];
  }
}

export function revisionMedia(revision: ContentRevisionRow): MediaRow[] {
  const media = JSON.parse(revision.media_json) as MediaRow[];
  const relation = revisionContentMedia(revision);
  if (!relation.length) return media;
  const byId = new Map(media.map((item) => [item.id, item]));
  return relation
    .filter((item) => item.role !== 'poster' && typeof item.mediaId === 'string')
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => byId.get(item.mediaId!))
    .filter((item): item is MediaRow => Boolean(item));
}

export function getContentRevision(revisionId: string): ContentRevisionRow {
  const row = db.prepare('SELECT * FROM content_revisions WHERE id=?').get(revisionId) as ContentRevisionRow | undefined;
  if (!row) throw new Error('ContentRevision не найдена');
  return row;
}

export function snapshotContentRevision(
  postId: string,
  expectedContentVersion: number,
  actorSource: RevisionActorSource
): ContentRevisionRow {
  const transaction = db.transaction(() => {
    const post = getPost(postId);
    ensureEditable(post);
    return snapshotCurrentContentRevision(postId, expectedContentVersion, actorSource);
  });
  return transaction();
}

export function markReadyRevision(
  postId: string,
  expectedContentVersion: number,
  revisionId: string
): void {
  const transaction = db.transaction(() => {
    const post = getPost(postId);
    ensureEditable(post);
    if (post.content_version !== expectedContentVersion) {
      throw new ContentConflictError(`READY не применён: версия ${expectedContentVersion} устарела, текущая ${post.content_version}`);
    }

    const revision = db.prepare('SELECT * FROM content_revisions WHERE id=? AND post_id=? AND content_version=?')
      .get(revisionId, postId, expectedContentVersion) as ContentRevisionRow | undefined;
    if (!revision) {
      throw new ContentConflictError('READY revision не соответствует текущей версии post');
    }

    const exact = snapshotCurrentContentRevision(
      postId,
      expectedContentVersion,
      revision.actor_source as RevisionActorSource,
      revision.restored_from_revision_id
    );
    if (exact.id !== revisionId) {
      throw new ContentConflictError('READY revision не является exact revision текущей версии');
    }

    const finalized = db.prepare(`UPDATE content_revisions
      SET editorial_stage='APPROVED'
      WHERE id=? AND post_id=? AND content_version=?
        AND editorial_stage IN ('IDEA','DRAFT','IN_REVIEW','APPROVED')`)
      .run(revisionId, postId, expectedContentVersion);
    if (finalized.changes !== 1) {
      throw new ContentConflictError('READY revision нельзя финализировать как APPROVED');
    }

    const updated = db.prepare(`UPDATE posts
      SET status='READY', editorial_stage='APPROVED', ready_revision_id=?, updated_at=?
      WHERE id=? AND content_version=? AND status IN ('DRAFT','READY','FAILED')`)
      .run(revisionId, nowIso(), postId, expectedContentVersion);
    if (updated.changes !== 1) {
      const fresh = getPost(postId);
      ensureEditable(fresh);
      throw new ContentConflictError(`READY не применён: версия ${expectedContentVersion} устарела, текущая ${fresh.content_version}`);
    }
  });

  transaction();
}
