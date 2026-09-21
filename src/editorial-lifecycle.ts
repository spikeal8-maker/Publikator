import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { db, event, id, nowIso } from './db.js';
import {
  ContentConflictError,
  ContentImmutableError,
  ContentNotFoundError,
  commitContentEdit,
  createInitialContentRevision,
  type RevisionActorSource
} from './content-versioning.js';

export type EditorialStage = 'IDEA' | 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'ARCHIVED' | 'TRASHED';
export type LifecycleResult = { contentVersion: number; editorialStage: EditorialStage; status: string };

type LifecyclePost = {
  id: string;
  title: string;
  status: string;
  editorial_stage: EditorialStage;
  content_version: number;
  ready_revision_id: string | null;
};

const FUTURE_STATUSES = new Set(['DRAFT', 'READY', 'FAILED']);
const PUBLISHED_STATUSES = new Set(['PARTIAL', 'PUBLISHED']);

function lifecyclePost(postId: string): LifecyclePost {
  const row = db.prepare(`SELECT id,title,status,editorial_stage,content_version,ready_revision_id
    FROM posts WHERE id=?`).get(postId) as LifecyclePost | undefined;
  if (!row) throw new ContentNotFoundError('Пост не найден');
  return row;
}

function assertVersion(post: LifecyclePost, expectedContentVersion: number): void {
  if (!Number.isInteger(expectedContentVersion) || expectedContentVersion < 1) {
    throw new Error('expectedContentVersion обязателен и должен быть положительным целым числом');
  }
  if (post.content_version !== expectedContentVersion) {
    throw new ContentConflictError(`Версия поста изменилась: ожидалась ${expectedContentVersion}, текущая ${post.content_version}`);
  }
}

function futureTransition(
  post: LifecyclePost,
  expectedContentVersion: number,
  nextStage: 'ARCHIVED' | 'TRASHED' | 'DRAFT',
  eventType: string,
  message: string
): LifecycleResult {
  if (!FUTURE_STATUSES.has(post.status)) {
    throw new ContentImmutableError('Операция доступна только для ещё не опубликованного поста');
  }
  const committed = commitContentEdit(
    post.id,
    expectedContentVersion,
    'manual',
    () => undefined,
    { editorialStage: nextStage, status: 'DRAFT', allowInactive: true }
  );
  event({
    postId: post.id,
    type: eventType,
    message,
    data: { previousStage: post.editorial_stage, previousStatus: post.status, contentVersion: committed.contentVersion }
  });
  return { contentVersion: committed.contentVersion, editorialStage: nextStage, status: 'DRAFT' };
}

export function archivePost(postId: string, expectedContentVersion: number): LifecycleResult {
  const transaction = db.transaction((): LifecycleResult => {
    const post = lifecyclePost(postId);
    assertVersion(post, expectedContentVersion);
    if (post.status === 'PUBLISHING') throw new ContentImmutableError('Нельзя архивировать пост во время публикации');
    if (post.editorial_stage === 'TRASHED') throw new ContentImmutableError('Сначала восстановите пост из корзины');
    if (post.editorial_stage === 'ARCHIVED') {
      return { contentVersion: post.content_version, editorialStage: post.editorial_stage, status: post.status };
    }
    if (PUBLISHED_STATUSES.has(post.status)) {
      const updated = db.prepare(`UPDATE posts SET editorial_stage='ARCHIVED',updated_at=?
        WHERE id=? AND content_version=? AND editorial_stage=? AND status IN ('PARTIAL','PUBLISHED')`)
        .run(nowIso(), post.id, expectedContentVersion, post.editorial_stage);
      if (updated.changes !== 1) throw new ContentConflictError('Пост уже изменён другим запросом');
      event({ postId, type: 'post_archived', message: 'Опубликованный пост локально архивирован', data: { status: post.status } });
      return { contentVersion: post.content_version, editorialStage: 'ARCHIVED', status: post.status };
    }
    return futureTransition(post, expectedContentVersion, 'ARCHIVED', 'post_archived', 'Будущая публикация архивирована');
  });
  return transaction();
}

export function trashPost(postId: string, expectedContentVersion: number): LifecycleResult {
  const transaction = db.transaction((): LifecycleResult => {
    const post = lifecyclePost(postId);
    assertVersion(post, expectedContentVersion);
    if (post.editorial_stage === 'TRASHED') {
      return { contentVersion: post.content_version, editorialStage: post.editorial_stage, status: post.status };
    }
    if (post.status === 'PUBLISHING' || PUBLISHED_STATUSES.has(post.status)) {
      throw new ContentImmutableError('Опубликованный/частично опубликованный пост нельзя отправить в корзину; используйте локальный архив');
    }
    return futureTransition(post, expectedContentVersion, 'TRASHED', 'post_trashed', 'Будущая публикация перемещена в корзину');
  });
  return transaction();
}

export function restorePost(postId: string, expectedContentVersion: number): LifecycleResult {
  const transaction = db.transaction((): LifecycleResult => {
    const post = lifecyclePost(postId);
    assertVersion(post, expectedContentVersion);
    if (!['ARCHIVED', 'TRASHED'].includes(post.editorial_stage)) {
      throw new ContentImmutableError('Пост не находится в архиве или корзине');
    }
    if (post.status === 'PUBLISHING') throw new ContentImmutableError('Нельзя менять lifecycle во время публикации');
    if (PUBLISHED_STATUSES.has(post.status)) {
      if (post.editorial_stage !== 'ARCHIVED') throw new ContentImmutableError('Опубликованный пост можно восстановить только из архива');
      const updated = db.prepare(`UPDATE posts SET editorial_stage='APPROVED',updated_at=?
        WHERE id=? AND content_version=? AND editorial_stage='ARCHIVED' AND status IN ('PARTIAL','PUBLISHED')`)
        .run(nowIso(), post.id, expectedContentVersion);
      if (updated.changes !== 1) throw new ContentConflictError('Пост уже изменён другим запросом');
      event({ postId, type: 'post_unarchived', message: 'Опубликованный пост возвращён из локального архива', data: { status: post.status } });
      return { contentVersion: post.content_version, editorialStage: 'APPROVED', status: post.status };
    }
    return futureTransition(post, expectedContentVersion, 'DRAFT', 'post_restored', 'Публикация восстановлена как черновик');
  });
  return transaction();
}


export function requestReviewPost(
  postId: string,
  expectedContentVersion: number,
  actorSource: RevisionActorSource = 'manual'
): LifecycleResult {
  return db.transaction((): LifecycleResult => {
    const post = lifecyclePost(postId);
    assertVersion(post, expectedContentVersion);
    if (!FUTURE_STATUSES.has(post.status)) {
      throw new ContentImmutableError('Request review доступен только для ещё не опубликованного поста');
    }
    if (post.editorial_stage === 'ARCHIVED' || post.editorial_stage === 'TRASHED') {
      throw new ContentImmutableError('Сначала восстановите пост из архива или корзины');
    }
    if (post.editorial_stage === 'IN_REVIEW') {
      return { contentVersion: post.content_version, editorialStage: post.editorial_stage, status: post.status };
    }
    const committed = commitContentEdit(
      post.id,
      expectedContentVersion,
      actorSource,
      () => undefined,
      { editorialStage: 'IN_REVIEW', status: 'DRAFT' }
    );
    event({
      postId: post.id,
      type: 'post_review_requested',
      message: 'Публикация отправлена на проверку',
      data: { previousStage: post.editorial_stage, contentVersion: committed.contentVersion }
    });
    return { contentVersion: committed.contentVersion, editorialStage: 'IN_REVIEW', status: 'DRAFT' };
  })();
}

export function returnToDraftPost(
  postId: string,
  expectedContentVersion: number,
  actorSource: RevisionActorSource = 'manual'
): LifecycleResult {
  return db.transaction((): LifecycleResult => {
    const post = lifecyclePost(postId);
    assertVersion(post, expectedContentVersion);
    if (!FUTURE_STATUSES.has(post.status)) {
      throw new ContentImmutableError('Return to draft доступен только для ещё не опубликованного поста');
    }
    if (post.editorial_stage === 'ARCHIVED' || post.editorial_stage === 'TRASHED') {
      throw new ContentImmutableError('Сначала восстановите пост из архива или корзины');
    }
    if (post.editorial_stage === 'DRAFT' && post.status === 'DRAFT') {
      return { contentVersion: post.content_version, editorialStage: post.editorial_stage, status: post.status };
    }
    const committed = commitContentEdit(
      post.id,
      expectedContentVersion,
      actorSource,
      () => undefined,
      { editorialStage: 'DRAFT', status: 'DRAFT' }
    );
    event({
      postId: post.id,
      type: 'post_returned_to_draft',
      message: 'Публикация возвращена в черновик',
      data: { previousStage: post.editorial_stage, previousStatus: post.status, contentVersion: committed.contentVersion }
    });
    return { contentVersion: committed.contentVersion, editorialStage: 'DRAFT', status: 'DRAFT' };
  })();
}

export function approvePost(
  postId: string,
  expectedContentVersion: number,
  actorSource: RevisionActorSource = 'manual'
): LifecycleResult {
  return db.transaction((): LifecycleResult => {
    const post = lifecyclePost(postId);
    assertVersion(post, expectedContentVersion);
    if (!FUTURE_STATUSES.has(post.status)) {
      throw new ContentImmutableError('Approve доступен только для ещё не опубликованного поста');
    }
    if (post.editorial_stage !== 'IN_REVIEW') {
      throw new ContentImmutableError('Одобрить можно только публикацию на проверке');
    }
    const committed = commitContentEdit(
      post.id,
      expectedContentVersion,
      actorSource,
      () => undefined,
      { editorialStage: 'APPROVED', status: 'DRAFT' }
    );
    event({
      postId: post.id,
      type: 'post_approved',
      message: 'Публикация одобрена',
      data: { previousStage: post.editorial_stage, contentVersion: committed.contentVersion }
    });
    return { contentVersion: committed.contentVersion, editorialStage: 'APPROVED', status: 'DRAFT' };
  })();
}

export type EditorialActions = {
  edit: boolean;
  requestReview: boolean;
  returnToDraft: boolean;
  approve: boolean;
  markReady: boolean;
  publishNow: boolean;
  duplicate: boolean;
  archive: boolean;
  trash: boolean;
  restore: boolean;
  deletePermanently: boolean;
};

export function editorialActions(post: { status: string; editorial_stage: EditorialStage }): EditorialActions {
  const inactive = post.editorial_stage === 'ARCHIVED' || post.editorial_stage === 'TRASHED';
  const future = FUTURE_STATUSES.has(post.status);
  const published = PUBLISHED_STATUSES.has(post.status);
  return {
    edit: future && !inactive,
    requestReview: future && !inactive && ['IDEA','DRAFT','APPROVED'].includes(post.editorial_stage),
    returnToDraft: future && !inactive && ['IN_REVIEW','APPROVED'].includes(post.editorial_stage),
    approve: future && !inactive && post.editorial_stage === 'IN_REVIEW',
    markReady: future && !inactive && post.editorial_stage === 'APPROVED',
    publishNow: post.status === 'READY' && !inactive,
    duplicate: post.status !== 'PUBLISHING',
    archive: post.status !== 'PUBLISHING' && post.editorial_stage !== 'ARCHIVED' && post.editorial_stage !== 'TRASHED',
    trash: future && post.editorial_stage !== 'TRASHED',
    restore: inactive && (future || (published && post.editorial_stage === 'ARCHIVED')),
    deletePermanently: future && post.editorial_stage === 'TRASHED'
  };
}

export async function duplicatePost(
  postId: string,
  expectedContentVersion: number
): Promise<{ id: string; contentVersion: number }> {
  const source = db.prepare(`SELECT * FROM posts WHERE id=?`).get(postId) as any;
  if (!source) throw new ContentNotFoundError('Пост не найден');
  assertVersion(source as LifecyclePost, expectedContentVersion);
  if (source.status === 'PUBLISHING') throw new ContentImmutableError('Нельзя дублировать пост во время публикации');

  const sourceMedia = db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order,created_at').all(postId) as any[];
  const sourceContentMedia = db.prepare('SELECT * FROM content_media WHERE post_id=? ORDER BY sort_order,created_at').all(postId) as any[];
  const sourceTargets = db.prepare(`SELECT pt.*,tr.text_rich_json,tr.text_plain,tr.publication_kind AS rendition_publication_kind,
      tr.content_format AS rendition_content_format,tr.media_plan_json,tr.options_json
    FROM post_targets pt LEFT JOIN target_renditions tr ON tr.target_id=pt.id
    WHERE pt.post_id=? ORDER BY pt.rowid`).all(postId) as any[];

  const newPostId = id('post');
  const mediaIdMap = new Map<string, string>();
  const copiedPaths: string[] = [];
  const sourceRoot = path.resolve(config.mediaDir);
  const destinationDir = path.resolve(sourceRoot, newPostId);
  if (destinationDir === sourceRoot || !destinationDir.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error('Duplicate media directory safety check failed');
  }

  try {
    if (sourceMedia.length) await fs.mkdir(destinationDir, { recursive: true });
    for (const media of sourceMedia) {
      const newMediaId = id('med');
      mediaIdMap.set(String(media.id), newMediaId);
      const extension = path.extname(String(media.relative_path || '')) || path.extname(String(media.original_name || ''));
      const relativePath = path.posix.join(newPostId, `${newMediaId}${extension || ''}`);
      const sourceAbsolute = path.resolve(sourceRoot, String(media.relative_path));
      const destinationAbsolute = path.resolve(sourceRoot, relativePath);
      if (!sourceAbsolute.startsWith(`${sourceRoot}${path.sep}`) || !destinationAbsolute.startsWith(`${sourceRoot}${path.sep}`)) {
        throw new Error('Duplicate media path safety check failed');
      }
      await fs.copyFile(sourceAbsolute, destinationAbsolute);
      copiedPaths.push(destinationAbsolute);
    }

    db.transaction(() => {
      const now = nowIso();
      db.prepare(`INSERT INTO posts
        (id,project_id,title,body,body_rich_json,status,editorial_stage,schedule_mode,scheduled_at,scheduled_at_utc,schedule_timezone,
         publication_kind,content_format,content_version,ready_revision_id,created_at,updated_at)
        VALUES (?,?,?,?,?,'DRAFT','DRAFT','MANUAL',NULL,NULL,NULL,?,?,1,NULL,?,?)`)
        .run(
          newPostId,
          source.project_id,
          `${String(source.title)} — копия`,
          source.body,
          source.body_rich_json,
          source.publication_kind,
          source.content_format,
          now,
          now
        );

      const insertTarget = db.prepare(`INSERT INTO post_targets
        (id,post_id,account_id,enabled,override_text,state,attempts,next_attempt_at,external_id,external_url,last_error,published_at,updated_at)
        VALUES (?,?,?,?,?,'PENDING',0,NULL,NULL,NULL,NULL,NULL,?)`);
      const insertRendition = db.prepare(`INSERT INTO target_renditions
        (target_id,text_rich_json,text_plain,publication_kind,content_format,media_plan_json,options_json,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const target of sourceTargets) {
        const targetId = id('tgt');
        insertTarget.run(targetId, newPostId, target.account_id, target.enabled ? 1 : 0, target.override_text ?? null, now);
        const hasRendition = [
          target.text_rich_json,target.text_plain,target.rendition_publication_kind,target.rendition_content_format,target.media_plan_json,target.options_json
        ].some((value) => value !== null && value !== undefined);
        if (hasRendition) {
          insertRendition.run(
            targetId,target.text_rich_json ?? null,target.text_plain ?? null,target.rendition_publication_kind ?? null,
            target.rendition_content_format ?? null,target.media_plan_json ?? null,target.options_json ?? null,now
          );
        }
      }

      const insertMedia = db.prepare(`INSERT INTO media
        (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order,
         duration_ms,fps,video_codec,audio_codec,container,poster_asset_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const media of sourceMedia) {
        const newMediaId = mediaIdMap.get(String(media.id))!;
        const extension = path.extname(String(media.relative_path || '')) || path.extname(String(media.original_name || ''));
        const relativePath = path.posix.join(newPostId, `${newMediaId}${extension || ''}`);
        insertMedia.run(
          newMediaId,newPostId,media.original_name,relativePath,media.mime_type,media.size_bytes,media.width,media.height,
          media.sha256,now,media.sort_order,media.duration_ms ?? null,media.fps ?? null,media.video_codec ?? null,
          media.audio_codec ?? null,media.container ?? null,
          media.poster_asset_id ? mediaIdMap.get(String(media.poster_asset_id)) ?? null : null
        );
      }

      const insertContentMedia = db.prepare(`INSERT INTO content_media
        (id,post_id,media_id,sort_order,role,preview_duration_ms,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const item of sourceContentMedia) {
        const mapped = mediaIdMap.get(String(item.media_id));
        if (!mapped) continue;
        insertContentMedia.run(id('cm'), newPostId, mapped, item.sort_order, item.role, item.preview_duration_ms ?? null, now, now);
      }

      createInitialContentRevision(newPostId, 'manual');
      event({
        postId: newPostId,
        type: 'post_duplicated',
        message: 'Создана независимая копия публикации',
        data: { sourcePostId: postId, sourceContentVersion: expectedContentVersion }
      });
    })();

    return { id: newPostId, contentVersion: 1 };
  } catch (error) {
    await Promise.all(copiedPaths.map((file) => fs.rm(file, { force: true }))).catch(() => undefined);
    await fs.rm(destinationDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deletePostPermanently(
  postId: string,
  expectedContentVersion: number
): Promise<{ deleted: true; cleanupWarning: string | null }> {
  const post = lifecyclePost(postId);
  assertVersion(post, expectedContentVersion);
  if (post.editorial_stage !== 'TRASHED' || !FUTURE_STATUSES.has(post.status)) {
    throw new ContentImmutableError('Permanent delete разрешён только для неопубликованного поста в корзине');
  }
  const externalEvidence = db.prepare(`SELECT COUNT(*) AS count FROM post_targets
    WHERE post_id=? AND (state='PUBLISHED' OR external_id IS NOT NULL OR external_url IS NOT NULL OR published_at IS NOT NULL)`)
    .get(postId) as { count: number };
  if (externalEvidence.count > 0) {
    throw new ContentImmutableError('У поста есть признаки внешней публикации; permanent delete запрещён, используйте архив');
  }

  const mediaRows = db.prepare('SELECT relative_path FROM media WHERE post_id=?').all(postId) as Array<{ relative_path: string }>;
  const expectedPrefix = `${postId}/`;
  if (mediaRows.some((media) => !media.relative_path.startsWith(expectedPrefix))) {
    throw new ContentImmutableError('Media storage invariant нарушен; автоматическое permanent delete остановлено');
  }

  db.transaction(() => {
    const fresh = lifecyclePost(postId);
    assertVersion(fresh, expectedContentVersion);
    if (fresh.editorial_stage !== 'TRASHED' || !FUTURE_STATUSES.has(fresh.status)) {
      throw new ContentConflictError('Lifecycle поста изменился перед permanent delete');
    }
    const removed = db.prepare(`DELETE FROM posts
      WHERE id=? AND content_version=? AND editorial_stage='TRASHED' AND status IN ('DRAFT','READY','FAILED')`)
      .run(postId, expectedContentVersion);
    if (removed.changes !== 1) throw new ContentConflictError('Пост уже изменён другим запросом');
    event({
      type: 'post_deleted_permanently',
      message: 'Пост окончательно удалён из Publikator',
      data: { deletedPostId: postId, title: post.title, contentVersion: expectedContentVersion, mediaCount: mediaRows.length }
    });
  })();

  const root = path.resolve(config.mediaDir);
  const postDir = path.resolve(root, postId);
  let cleanupWarning: string | null = null;
  if (postDir === root || !postDir.startsWith(`${root}${path.sep}`)) {
    cleanupWarning = 'Media directory safety check failed; directory was not removed';
  } else {
    try {
      await fs.rm(postDir, { recursive: true, force: true });
    } catch (error) {
      cleanupWarning = error instanceof Error ? error.message : String(error);
      event({ level: 'warning', type: 'post_media_cleanup_failed', message: 'Пост удалён, но media directory не удалось очистить', data: { deletedPostId: postId, error: cleanupWarning } });
    }
  }
  return { deleted: true, cleanupWarning };
}
