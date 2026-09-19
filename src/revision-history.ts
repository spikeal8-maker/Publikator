import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, event, id, nowIso } from './db.js';
import {
  ContentConflictError,
  commitContentEdit,
  currentContentSnapshot,
  getContentRevision,
  revisionContentMedia,
  revisionTargets,
  type ContentRevisionRow,
  type RevisionContentMediaSnapshot,
  type RevisionTargetSnapshot
} from './content-versioning.js';
import type { MediaRow } from './media.js';

export class RevisionHistoryNotFoundError extends Error {}

export class RevisionRestoreBlockedError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

type PostHistoryState = {
  id: string;
  status: string;
  editorial_stage: string;
  content_version: number;
  ready_revision_id: string | null;
};

export type RevisionSummary = {
  id: string;
  contentVersion: number;
  createdAt: string;
  actorSource: string;
  editorialStage: string;
  restoredFromRevisionId: string | null;
  restoredFromContentVersion: number | null;
  isCurrent: boolean;
  isReadyRevision: boolean;
};

export type RevisionTargetDetail = {
  targetId: string;
  accountId: string;
  accountName: string | null;
  platform: string | null;
  accountMissing: boolean;
  enabled: boolean;
  overrideText: string | null;
  rendition: RevisionTargetSnapshot['rendition'];
};

export type RevisionMediaDetail = {
  id: string;
  originalName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  sortOrder: number;
  durationMs: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  posterAssetId: string | null;
};

export type RevisionDetail = RevisionSummary & {
  postId: string;
  title: string;
  body: string;
  scheduleMode: string;
  scheduledAt: string | null;
  scheduledAtUtc: string | null;
  scheduleTimezone: string | null;
  publicationKind: string;
  contentFormat: string;
  targets: RevisionTargetDetail[];
  media: RevisionMediaDetail[];
  contentMedia: RevisionContentMediaSnapshot[];
};

export type TextDiffLine = {
  type: 'unchanged' | 'added' | 'removed';
  text: string;
};

export type TextDiff =
  | { mode: 'lines'; lines: TextDiffLine[] }
  | { mode: 'fallback'; before: string; after: string; reason: 'bounds_exceeded' };

export type RestoreCompatibility = {
  canRestore: boolean;
  code: string | null;
  reason: string | null;
};

const TEXT_DIFF_MAX_CHARS = 40_000;
const TEXT_DIFF_MAX_LINES = 400;
const RESTORABLE_STATUSES = new Set(['DRAFT', 'READY', 'FAILED']);
const INACTIVE_EDITORIAL_STAGES = new Set(['ARCHIVED', 'TRASHED']);
const EXTERNAL_PUBLICATION_EVIDENCE_REASON =
  'Эту версию нельзя восстановить: у материала есть подтверждённая или неразрешённая внешняя публикация.';

export type ExternalPublicationEvidence = {
  hasEvidence: boolean;
  targetEvidence: boolean;
  publicationUnitEvidence: boolean;
};

export function externalPublicationEvidence(postId: string): ExternalPublicationEvidence {
  const targetEvidence = Boolean(db.prepare(`SELECT 1 FROM post_targets
    WHERE post_id=?
      AND (
        state IN ('PUBLISHED','PARTIAL','RECOVERY_NEEDED')
        OR external_id IS NOT NULL
        OR external_url IS NOT NULL
        OR published_at IS NOT NULL
      )
    LIMIT 1`).get(postId));

  const publicationUnitEvidence = Boolean(db.prepare(`SELECT 1
    FROM publication_units pu
    JOIN post_targets pt ON pt.id=pu.target_id
    WHERE pt.post_id=?
      AND (
        pu.state IN ('PUBLISHED','RECOVERY_NEEDED')
        OR pu.external_id IS NOT NULL
        OR pu.external_url IS NOT NULL
        OR pu.published_at IS NOT NULL
      )
    LIMIT 1`).get(postId));

  return {
    hasEvidence: targetEvidence || publicationUnitEvidence,
    targetEvidence,
    publicationUnitEvidence
  };
}

function externalPublicationEvidenceCompatibility(postId: string): RestoreCompatibility | null {
  if (!externalPublicationEvidence(postId).hasEvidence) return null;
  return {
    canRestore: false,
    code: 'REVISION_EXTERNAL_PUBLICATION_EVIDENCE',
    reason: EXTERNAL_PUBLICATION_EVIDENCE_REASON
  };
}

function postHistoryState(postId: string): PostHistoryState {
  const row = db.prepare(`SELECT id,status,editorial_stage,content_version,ready_revision_id
    FROM posts WHERE id=?`).get(postId) as PostHistoryState | undefined;
  if (!row) throw new RevisionHistoryNotFoundError('Пост не найден');
  return row;
}

function revisionForPost(postId: string, revisionId: string): ContentRevisionRow {
  const row = db.prepare('SELECT * FROM content_revisions WHERE id=? AND post_id=?')
    .get(revisionId, postId) as ContentRevisionRow | undefined;
  if (!row) throw new RevisionHistoryNotFoundError('Revision не найдена');
  return row;
}

function parseMedia(revision: ContentRevisionRow): MediaRow[] {
  try {
    const value = JSON.parse(revision.media_json);
    return Array.isArray(value) ? value as MediaRow[] : [];
  } catch {
    return [];
  }
}

function mediaDetail(row: MediaRow): RevisionMediaDetail {
  return {
    id: row.id,
    originalName: row.original_name,
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    width: row.width ?? null,
    height: row.height ?? null,
    sha256: row.sha256,
    sortOrder: Number(row.sort_order),
    durationMs: row.duration_ms ?? null,
    fps: row.fps ?? null,
    videoCodec: row.video_codec ?? null,
    audioCodec: row.audio_codec ?? null,
    container: row.container ?? null,
    posterAssetId: row.poster_asset_id ?? null
  };
}

function restoredFromVersion(revision: ContentRevisionRow): number | null {
  if (!revision.restored_from_revision_id) return null;
  const row = db.prepare('SELECT content_version FROM content_revisions WHERE id=?')
    .get(revision.restored_from_revision_id) as { content_version: number } | undefined;
  return row?.content_version ?? null;
}

function summary(revision: ContentRevisionRow, post: PostHistoryState): RevisionSummary {
  return {
    id: revision.id,
    contentVersion: revision.content_version,
    createdAt: revision.created_at,
    actorSource: revision.actor_source,
    editorialStage: revision.editorial_stage,
    restoredFromRevisionId: revision.restored_from_revision_id,
    restoredFromContentVersion: restoredFromVersion(revision),
    isCurrent: revision.content_version === post.content_version,
    isReadyRevision: revision.id === post.ready_revision_id
  };
}

function targetDetails(revision: ContentRevisionRow): RevisionTargetDetail[] {
  const targets = revisionTargets(revision);
  const accountIds = [...new Set(targets.map((target) => target.accountId))];
  const accounts = new Map<string, { id: string; platform: string; name: string }>();
  if (accountIds.length) {
    const placeholders = accountIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id,platform,name FROM social_accounts WHERE id IN (${placeholders})`)
      .all(...accountIds) as Array<{ id: string; platform: string; name: string }>;
    for (const row of rows) accounts.set(row.id, row);
  }
  return targets.map((target) => {
    const account = accounts.get(target.accountId);
    return {
      targetId: target.targetId,
      accountId: target.accountId,
      accountName: account?.name ?? null,
      platform: account?.platform ?? null,
      accountMissing: !account,
      enabled: target.enabled,
      overrideText: target.overrideText,
      rendition: target.rendition
    };
  });
}

export function listPostRevisions(
  postId: string,
  input: { limit?: number; beforeVersion?: number } = {}
): { items: RevisionSummary[]; nextBeforeVersion: number | null } {
  const post = postHistoryState(postId);
  const limit = input.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit должен быть целым числом от 1 до 100');
  if (input.beforeVersion !== undefined && (!Number.isInteger(input.beforeVersion) || input.beforeVersion < 1)) {
    throw new Error('beforeVersion должен быть положительным целым числом');
  }

  const rows = (input.beforeVersion === undefined
    ? db.prepare('SELECT * FROM content_revisions WHERE post_id=? ORDER BY content_version DESC LIMIT ?')
      .all(postId, limit + 1)
    : db.prepare('SELECT * FROM content_revisions WHERE post_id=? AND content_version<? ORDER BY content_version DESC LIMIT ?')
      .all(postId, input.beforeVersion, limit + 1)) as ContentRevisionRow[];

  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  return {
    items: visible.map((revision) => summary(revision, post)),
    nextBeforeVersion: hasMore && visible.length ? visible[visible.length - 1]!.content_version : null
  };
}

export function getRevisionDetail(postId: string, revisionId: string): RevisionDetail {
  const post = postHistoryState(postId);
  const revision = revisionForPost(postId, revisionId);
  return {
    ...summary(revision, post),
    postId,
    title: revision.title,
    body: revision.body,
    scheduleMode: revision.schedule_mode,
    scheduledAt: revision.scheduled_at,
    scheduledAtUtc: revision.scheduled_at_utc,
    scheduleTimezone: revision.schedule_timezone,
    publicationKind: revision.publication_kind,
    contentFormat: revision.content_format,
    targets: targetDetails(revision),
    media: parseMedia(revision).map(mediaDetail),
    contentMedia: revisionContentMedia(revision)
  };
}

export function diffText(before: string, after: string): TextDiff {
  if (before.length + after.length > TEXT_DIFF_MAX_CHARS) {
    return { mode: 'fallback', before, after, reason: 'bounds_exceeded' };
  }
  const left = before.replace(/\r\n/g, '\n').split('\n');
  const right = after.replace(/\r\n/g, '\n').split('\n');
  if (left.length > TEXT_DIFF_MAX_LINES || right.length > TEXT_DIFF_MAX_LINES) {
    return { mode: 'fallback', before, after, reason: 'bounds_exceeded' };
  }

  const matrix = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      matrix[i]![j] = left[i] === right[j]
        ? matrix[i + 1]![j + 1]! + 1
        : Math.max(matrix[i + 1]![j]!, matrix[i]![j + 1]!);
    }
  }

  const lines: TextDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push({ type: 'unchanged', text: left[i]! });
      i += 1;
      j += 1;
    } else if (j < right.length && (i >= left.length || matrix[i]![j + 1]! >= matrix[i + 1]![j]!)) {
      lines.push({ type: 'added', text: right[j]! });
      j += 1;
    } else {
      lines.push({ type: 'removed', text: left[i]! });
      i += 1;
    }
  }
  return { mode: 'lines', lines };
}

function targetSemantic(target: RevisionTargetSnapshot): string {
  return JSON.stringify({
    enabled: target.enabled,
    overrideText: target.overrideText,
    rendition: target.rendition
  });
}

function targetDiff(before: RevisionTargetSnapshot[], after: RevisionTargetSnapshot[]) {
  const previous = new Map(before.map((item) => [item.accountId, item]));
  const current = new Map(after.map((item) => [item.accountId, item]));
  const added = [...current.entries()]
    .filter(([accountId]) => !previous.has(accountId))
    .map(([, value]) => ({ ...value }));
  const removed = [...previous.entries()]
    .filter(([accountId]) => !current.has(accountId))
    .map(([, value]) => ({ ...value }));
  const changed = [...previous.entries()]
    .filter(([accountId, value]) => current.has(accountId) && targetSemantic(value) !== targetSemantic(current.get(accountId)!))
    .map(([accountId, value]) => ({ accountId, before: value, after: current.get(accountId)! }));
  return { added, removed, changed };
}

function contentMediaSemantic(items: RevisionContentMediaSnapshot[]): string {
  return JSON.stringify(items.map((item) => ({
    mediaId: item.mediaId,
    sortOrder: item.sortOrder,
    role: item.role,
    previewDurationMs: item.previewDurationMs
  })));
}

async function fileSha256(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function mediaCompatibility(revision: ContentRevisionRow, currentMedia: MediaRow[]): Promise<RestoreCompatibility> {
  const historical = parseMedia(revision);
  if (historical.length !== currentMedia.length) {
    return {
      canRestore: false,
      code: 'REVISION_MEDIA_INCOMPATIBLE',
      reason: 'Эту версию нельзя полностью восстановить: набор медиа изменился.'
    };
  }
  const currentById = new Map(currentMedia.map((item) => [item.id, item]));
  for (const item of historical) {
    const current = currentById.get(item.id);
    if (!current || current.sha256 !== item.sha256 || current.relative_path !== item.relative_path) {
      return {
        canRestore: false,
        code: 'REVISION_MEDIA_INCOMPATIBLE',
        reason: 'Эту версию нельзя полностью восстановить: набор медиа изменился.'
      };
    }
    const filePath = path.join(config.mediaDir, ...item.relative_path.split('/'));
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.size !== Number(item.size_bytes) || await fileSha256(filePath) !== item.sha256) {
      return {
        canRestore: false,
        code: 'REVISION_MEDIA_INCOMPATIBLE',
        reason: 'Эту версию нельзя полностью восстановить: файл исторического медиа недоступен или изменён.'
      };
    }
  }
  return { canRestore: true, code: null, reason: null };
}

function targetCompatibility(revision: ContentRevisionRow): RestoreCompatibility {
  const targets = revisionTargets(revision);
  for (const target of targets) {
    const account = db.prepare('SELECT id FROM social_accounts WHERE id=?').get(target.accountId) as { id: string } | undefined;
    if (!account) {
      return {
        canRestore: false,
        code: 'REVISION_TARGET_INCOMPATIBLE',
        reason: `Эту версию нельзя полностью восстановить: площадка ${target.accountId} больше не существует.`
      };
    }
  }
  return { canRestore: true, code: null, reason: null };
}

export async function revisionRestoreCompatibility(postId: string, revisionId: string): Promise<RestoreCompatibility> {
  const post = postHistoryState(postId);
  const revision = revisionForPost(postId, revisionId);
  const publicationEvidence = externalPublicationEvidenceCompatibility(postId);
  if (publicationEvidence) return publicationEvidence;
  if (INACTIVE_EDITORIAL_STAGES.has(post.editorial_stage)) {
    return {
      canRestore: false,
      code: 'REVISION_LIFECYCLE_INACTIVE',
      reason: 'Сначала восстановите материал из архива или корзины.'
    };
  }
  if (!RESTORABLE_STATUSES.has(post.status)) {
    return {
      canRestore: false,
      code: 'REVISION_PUBLISHED_IMMUTABLE',
      reason: 'Опубликованный материал нельзя переписать восстановлением старой версии.'
    };
  }
  if (revision.content_version === post.content_version) {
    return { canRestore: false, code: 'REVISION_ALREADY_CURRENT', reason: 'Эта версия уже является текущей.' };
  }
  const targets = targetCompatibility(revision);
  if (!targets.canRestore) return targets;
  return mediaCompatibility(revision, currentContentSnapshot(postId).media);
}

function fieldDiff<T>(before: T, after: T) {
  return { before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
}

export async function getRevisionDiff(postId: string, revisionId: string) {
  const revision = revisionForPost(postId, revisionId);
  const current = currentContentSnapshot(postId);
  const historicalTargets = revisionTargets(revision);
  const historicalMedia = revisionContentMedia(revision);
  const compatibility = await revisionRestoreCompatibility(postId, revisionId);
  return {
    revision: getRevisionDetail(postId, revisionId),
    currentContentVersion: current.contentVersion,
    text: {
      title: fieldDiff(revision.title, current.title),
      body: {
        before: revision.body,
        after: current.body,
        changed: revision.body !== current.body,
        diff: diffText(revision.body, current.body)
      }
    },
    publication: {
      editorialStage: fieldDiff(revision.editorial_stage, current.editorialStage),
      scheduleMode: fieldDiff(revision.schedule_mode, current.scheduleMode),
      scheduledAtUtc: fieldDiff(revision.scheduled_at_utc ?? revision.scheduled_at, current.scheduledAtUtc ?? current.scheduledAt),
      scheduleTimezone: fieldDiff(revision.schedule_timezone, current.scheduleTimezone),
      publicationKind: fieldDiff(revision.publication_kind, current.publicationKind),
      contentFormat: fieldDiff(revision.content_format, current.contentFormat)
    },
    targets: targetDiff(historicalTargets, current.targets),
    media: {
      before: historicalMedia,
      after: current.contentMedia,
      changed: contentMediaSemantic(historicalMedia) !== contentMediaSemantic(current.contentMedia)
    },
    restoreCompatibility: compatibility
  };
}

function restoreTargets(postId: string, snapshot: RevisionTargetSnapshot[]): void {
  const now = nowIso();
  const rows = db.prepare('SELECT id,account_id FROM post_targets WHERE post_id=?').all(postId) as Array<{ id: string; account_id: string }>;
  const byAccount = new Map(rows.map((row) => [row.account_id, row]));
  if (rows.length) {
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM target_renditions WHERE target_id IN (${placeholders})`).run(...ids);
  }
  db.prepare(`UPDATE post_targets
    SET enabled=0,override_text=NULL,state='PENDING',attempts=0,next_attempt_at=NULL,
        external_id=NULL,external_url=NULL,last_error=NULL,published_at=NULL,updated_at=?
    WHERE post_id=?`).run(now, postId);

  const insertTarget = db.prepare(`INSERT INTO post_targets
    (id,post_id,account_id,enabled,override_text,state,attempts,updated_at)
    VALUES (?,?,?,?,?,'PENDING',0,?)`);
  const updateTarget = db.prepare(`UPDATE post_targets
    SET enabled=?,override_text=?,state='PENDING',attempts=0,next_attempt_at=NULL,
        external_id=NULL,external_url=NULL,last_error=NULL,published_at=NULL,updated_at=?
    WHERE id=?`);
  const insertRendition = db.prepare(`INSERT INTO target_renditions
    (target_id,text_rich_json,text_plain,publication_kind,content_format,media_plan_json,options_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`);

  for (const target of snapshot) {
    let row = byAccount.get(target.accountId);
    if (!row) {
      const targetId = id('target');
      insertTarget.run(targetId, postId, target.accountId, target.enabled ? 1 : 0, target.overrideText, now);
      row = { id: targetId, account_id: target.accountId };
      byAccount.set(target.accountId, row);
    } else {
      updateTarget.run(target.enabled ? 1 : 0, target.overrideText, now, row.id);
    }
    if (target.rendition) {
      insertRendition.run(
        row.id,
        target.rendition.textRichJson,
        target.rendition.textPlain,
        target.rendition.publicationKind,
        target.rendition.contentFormat,
        target.rendition.mediaPlanJson,
        target.rendition.optionsJson,
        now
      );
    }
  }
}

function restoreMedia(postId: string, revision: ContentRevisionRow): void {
  const historical = parseMedia(revision);
  const update = db.prepare(`UPDATE media SET
      original_name=?,mime_type=?,size_bytes=?,width=?,height=?,sort_order=?,
      duration_ms=?,fps=?,video_codec=?,audio_codec=?,container=?,poster_asset_id=?
    WHERE id=? AND post_id=?`);
  for (const media of historical) {
    update.run(
      media.original_name,
      media.mime_type,
      media.size_bytes,
      media.width ?? null,
      media.height ?? null,
      media.sort_order,
      media.duration_ms ?? null,
      media.fps ?? null,
      media.video_codec ?? null,
      media.audio_codec ?? null,
      media.container ?? null,
      media.poster_asset_id ?? null,
      media.id,
      postId
    );
  }

  db.prepare('DELETE FROM content_media WHERE post_id=?').run(postId);
  const relation = revisionContentMedia(revision);
  const insert = db.prepare(`INSERT INTO content_media
    (id,post_id,media_id,sort_order,role,preview_duration_ms,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const now = nowIso();
  for (const item of relation) {
    if (!item.mediaId) continue;
    insert.run(id('cm'), postId, item.mediaId, item.sortOrder, item.role, item.previewDurationMs, now, now);
  }
}

export async function restoreRevision(
  postId: string,
  revisionId: string,
  expectedContentVersion: number
): Promise<{ contentVersion: number; revisionId: string; restoredFromRevisionId: string }> {
  const selected = revisionForPost(postId, revisionId);
  const compatibility = await revisionRestoreCompatibility(postId, revisionId);
  if (!compatibility.canRestore) {
    throw new RevisionRestoreBlockedError(compatibility.code ?? 'REVISION_RESTORE_BLOCKED', compatibility.reason ?? 'Restore заблокирован');
  }

  const transaction = db.transaction(() => {
    const publicationEvidence = externalPublicationEvidenceCompatibility(postId);
    if (publicationEvidence) {
      throw new RevisionRestoreBlockedError(
        publicationEvidence.code ?? 'REVISION_EXTERNAL_PUBLICATION_EVIDENCE',
        publicationEvidence.reason ?? EXTERNAL_PUBLICATION_EVIDENCE_REASON
      );
    }

    const committed = commitContentEdit(postId, expectedContentVersion, 'manual_restore', () => {
      db.prepare(`UPDATE posts SET
        title=?,body=?,schedule_mode=?,scheduled_at=?,scheduled_at_utc=?,schedule_timezone=?,
        publication_kind=?,content_format=?
        WHERE id=?`).run(
        selected.title,
        selected.body,
        selected.schedule_mode,
        selected.scheduled_at,
        selected.scheduled_at_utc,
        selected.schedule_timezone,
        selected.publication_kind,
        selected.content_format,
        postId
      );
      restoreTargets(postId, revisionTargets(selected));
      restoreMedia(postId, selected);
    }, {
      status: 'DRAFT',
      editorialStage: 'DRAFT',
      restoredFromRevisionId: selected.id
    });

    event({
      postId,
      type: 'post_revision_restored',
      message: `Восстановлена версия ${selected.content_version} как новая версия ${committed.contentVersion}`,
      data: {
        restoredRevisionId: selected.id,
        restoredRevisionContentVersion: selected.content_version,
        previousContentVersion: expectedContentVersion,
        resultingContentVersion: committed.contentVersion,
        actorSource: 'manual_restore'
      }
    });
    return committed;
  });

  try {
    const committed = transaction();
    return {
      contentVersion: committed.contentVersion,
      revisionId: committed.revision.id,
      restoredFromRevisionId: selected.id
    };
  } catch (error) {
    if (error instanceof ContentConflictError) throw error;
    throw error;
  }
}
