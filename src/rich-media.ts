import { db, nowIso } from './db.js';
import { commitContentEdit } from './content-versioning.js';
import type { ContentFormat, PublicationKind } from './domain/content-domain.js';

export type ContentMediaRole = 'primary' | 'carousel_item' | 'story_item' | 'video' | 'poster';

export type ContentMediaRow = {
  id: string;
  post_id: string;
  media_id: string;
  sort_order: number;
  role: ContentMediaRole;
  preview_duration_ms: number | null;
  created_at: string;
  updated_at: string;
};

export type RichMediaItemInput = {
  mediaId: string;
  role: ContentMediaRole;
  previewDurationMs?: number | null;
};

export type VideoMetadataInput = {
  durationMs: number;
  fps?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  container?: string | null;
  posterAssetId?: string | null;
};

const ROLE_BY_FORMAT: Record<ContentFormat, ContentMediaRole | null> = {
  TEXT_ONLY: null,
  IMAGE: 'primary',
  CAROUSEL: 'carousel_item',
  VIDEO: 'video',
  VERTICAL_VIDEO: 'video',
  STORY_SEQUENCE: 'story_item'
};

function assertKindFormat(kind: PublicationKind, format: ContentFormat): void {
  const allowed: Record<PublicationKind, Set<ContentFormat>> = {
    FEED: new Set(['TEXT_ONLY', 'IMAGE', 'CAROUSEL', 'VIDEO']),
    SHORT: new Set(['VERTICAL_VIDEO']),
    STORY: new Set(['IMAGE', 'VERTICAL_VIDEO', 'STORY_SEQUENCE'])
  };
  if (!allowed[kind].has(format)) throw new Error(`Unsupported canonical composition ${kind}/${format}`);
}

function assertComposition(format: ContentFormat, items: RichMediaItemInput[]): void {
  const primary = items.filter((item) => item.role !== 'poster');
  const expectedRole = ROLE_BY_FORMAT[format];
  if (format === 'TEXT_ONLY') {
    if (primary.length !== 0) throw new Error('TEXT_ONLY cannot contain primary media items');
    return;
  }
  if (format === 'CAROUSEL' && primary.length < 2) throw new Error('CAROUSEL requires at least two media items');
  if (format === 'STORY_SEQUENCE' && primary.length < 1) throw new Error('STORY_SEQUENCE requires at least one story item');
  if (!['CAROUSEL', 'STORY_SEQUENCE'].includes(format) && primary.length !== 1) {
    throw new Error(`${format} requires exactly one primary media item`);
  }
  if (primary.some((item) => item.role !== expectedRole)) {
    throw new Error(`${format} requires content media role ${expectedRole}`);
  }
}

function mediaForPost(postId: string): Array<{ id: string; mime_type: string }> {
  return db.prepare('SELECT id,mime_type FROM media WHERE post_id=? ORDER BY sort_order,created_at').all(postId) as Array<{ id: string; mime_type: string }>;
}

export function listContentMedia(postId: string): ContentMediaRow[] {
  return db.prepare('SELECT * FROM content_media WHERE post_id=? ORDER BY sort_order,created_at').all(postId) as ContentMediaRow[];
}

export function setContentCompositionVersioned(
  postId: string,
  expectedContentVersion: number,
  publicationKind: PublicationKind,
  contentFormat: ContentFormat,
  items: RichMediaItemInput[]
): { contentVersion: number; items: ContentMediaRow[] } {
  assertKindFormat(publicationKind, contentFormat);
  if (new Set(items.map((item) => item.mediaId)).size !== items.length) throw new Error('Content media contains duplicate mediaId values');
  for (const item of items) {
    if (item.previewDurationMs != null && (!Number.isInteger(item.previewDurationMs) || item.previewDurationMs <= 0)) {
      throw new Error('previewDurationMs must be a positive integer');
    }
  }
  assertComposition(contentFormat, items);
  const media = mediaForPost(postId);
  const mediaById = new Map(media.map((row) => [row.id, row]));
  if (items.length !== media.length || items.some((item) => !mediaById.has(item.mediaId))) {
    throw new Error('Composition must describe every media asset attached to the post');
  }
  for (const item of items) {
    const row = mediaById.get(item.mediaId)!;
    if (item.role === 'poster' && !row.mime_type.startsWith('image/')) throw new Error('Poster asset must be an image');
    if (item.role === 'video' && !row.mime_type.startsWith('video/')) throw new Error('Video role requires a video media asset');
  }

  const committed = commitContentEdit(postId, expectedContentVersion, 'manual', () => {
    const updateMediaOrder = db.prepare('UPDATE media SET sort_order=? WHERE id=? AND post_id=?');
    const upsertContentMedia = db.prepare(`INSERT INTO content_media
      (id,post_id,media_id,sort_order,role,preview_duration_ms,created_at,updated_at)
      VALUES ('cm_' || ?,?,?,?,?,?,?,?)
      ON CONFLICT(post_id,media_id) DO UPDATE SET
        sort_order=excluded.sort_order,role=excluded.role,preview_duration_ms=excluded.preview_duration_ms,updated_at=excluded.updated_at`);
    const now = nowIso();
    items.forEach((item, index) => {
      updateMediaOrder.run(index, item.mediaId, postId);
      upsertContentMedia.run(item.mediaId, postId, item.mediaId, index, item.role, item.previewDurationMs ?? null, now, now);
    });
    db.prepare('UPDATE posts SET publication_kind=?,content_format=? WHERE id=?').run(publicationKind, contentFormat, postId);
    return listContentMedia(postId);
  });
  return { contentVersion: committed.contentVersion, items: committed.value };
}

export function setVideoMetadataVersioned(
  mediaId: string,
  expectedContentVersion: number,
  metadata: VideoMetadataInput
): { contentVersion: number } {
  if (!Number.isInteger(metadata.durationMs) || metadata.durationMs <= 0) throw new Error('durationMs must be a positive integer');
  if (metadata.fps != null && (!Number.isFinite(metadata.fps) || metadata.fps <= 0)) throw new Error('fps must be positive');
  const media = db.prepare('SELECT id,post_id,mime_type FROM media WHERE id=?').get(mediaId) as { id: string; post_id: string; mime_type: string } | undefined;
  if (!media) throw new Error('Media asset not found');
  if (!media.mime_type.startsWith('video/')) throw new Error('Video metadata can only be attached to a video asset');
  if (metadata.posterAssetId) {
    if (metadata.posterAssetId === mediaId) throw new Error('Video cannot use itself as poster');
    const poster = db.prepare('SELECT id,mime_type FROM media WHERE id=? AND post_id=?').get(metadata.posterAssetId, media.post_id) as { id: string; mime_type: string } | undefined;
    if (!poster || !poster.mime_type.startsWith('image/')) throw new Error('Poster asset must be an image from the same post');
  }
  const committed = commitContentEdit(media.post_id, expectedContentVersion, 'manual', () => {
    db.prepare(`UPDATE media SET duration_ms=?,fps=?,video_codec=?,audio_codec=?,container=?,poster_asset_id=? WHERE id=?`)
      .run(metadata.durationMs, metadata.fps ?? null, metadata.videoCodec ?? null, metadata.audioCodec ?? null,
        metadata.container ?? null, metadata.posterAssetId ?? null, mediaId);
    if (metadata.posterAssetId) {
      db.prepare("UPDATE content_media SET role='poster',updated_at=? WHERE post_id=? AND media_id=?")
        .run(nowIso(), media.post_id, metadata.posterAssetId);
    }
  });
  return { contentVersion: committed.contentVersion };
}
