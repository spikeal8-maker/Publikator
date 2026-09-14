import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from './config.js';
import { db, id, nowIso } from './db.js';
import { assertContentVersion, commitContentEdit } from './content-versioning.js';
import { prepareVideoUpload } from './video-media.js';

const MAX_IMAGE_DIMENSION = 7680;

export type MediaRow = {
  id: string;
  post_id: string;
  original_name: string;
  relative_path: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  created_at: string;
  sort_order: number;
  duration_ms?: number | null;
  fps?: number | null;
  video_codec?: string | null;
  audio_codec?: string | null;
  container?: string | null;
  poster_asset_id?: string | null;
};

type PreparedImage = {
  data: Buffer;
  width: number;
  height: number;
  sha256: string;
};

async function prepareImage(input: Buffer): Promise<PreparedImage> {
  if (input.byteLength > config.maxImageBytes) throw new Error(`Изображение больше ${config.maxImageBytes} байт`);
  try {
    const source = sharp(input, { failOn: 'error' }).rotate();
    const sourceMetadata = await source.metadata();
    if (!sourceMetadata.width || !sourceMetadata.height) throw new Error('Файл не является корректным изображением');
    if (sourceMetadata.width > MAX_IMAGE_DIMENSION || sourceMetadata.height > MAX_IMAGE_DIMENSION) {
      throw new Error(`Изображение превышает ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}`);
    }
    const result = await source.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (result.data.byteLength > config.maxImageBytes) throw new Error(`Нормализованное изображение больше ${config.maxImageBytes} байт`);
    if (!result.info.width || !result.info.height || result.info.width > MAX_IMAGE_DIMENSION || result.info.height > MAX_IMAGE_DIMENSION) {
      throw new Error(`Изображение превышает ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}`);
    }
    return {
      data: result.data,
      width: result.info.width,
      height: result.info.height,
      sha256: crypto.createHash('sha256').update(result.data).digest('hex')
    };
  } catch (error) {
    if (error instanceof Error && (error.message.includes('превышает') || error.message.includes('корректным изображением') || error.message.includes('байт'))) throw error;
    throw new Error(`Не удалось обработать изображение: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function duplicateMedia(postId: string, sha256: string): MediaRow | undefined {
  return db.prepare('SELECT * FROM media WHERE post_id=? AND sha256=? ORDER BY sort_order,created_at LIMIT 1')
    .get(postId, sha256) as MediaRow | undefined;
}

export function syncImageContentFormat(postId: string): 'IMAGE' | 'CAROUSEL' {
  const count = Number((db.prepare('SELECT COUNT(*) AS count FROM media WHERE post_id=?').get(postId) as { count: number }).count);
  const format = count > 1 ? 'CAROUSEL' : 'IMAGE';
  db.prepare("UPDATE posts SET content_format=? WHERE id=? AND publication_kind='FEED' AND content_format IN ('TEXT_ONLY','IMAGE','CAROUSEL')")
    .run(format, postId);
  return format;
}

function insertPreparedImage(postId: string, originalName: string, prepared: PreparedImage, mediaId: string): MediaRow {
  const duplicate = duplicateMedia(postId, prepared.sha256);
  if (duplicate) return duplicate;
  const relativePath = path.posix.join(postId, `${mediaId}.jpg`);
  const nextOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM media WHERE post_id=?')
    .get(postId) as { next_order: number }).next_order;
  const createdAt = nowIso();
  db.prepare(`INSERT INTO media
    (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mediaId, postId, originalName, relativePath, 'image/jpeg', prepared.data.byteLength, prepared.width, prepared.height, prepared.sha256, createdAt, nextOrder);
  syncImageContentFormat(postId);
  return db.prepare('SELECT * FROM media WHERE id=?').get(mediaId) as MediaRow;
}

async function writePreparedFile(postId: string, mediaId: string, prepared: PreparedImage): Promise<string> {
  const postDir = path.join(config.mediaDir, postId);
  await fs.mkdir(postDir, { recursive: true });
  const relativePath = path.posix.join(postId, `${mediaId}.jpg`);
  const absolutePath = path.join(config.mediaDir, relativePath);
  await fs.writeFile(absolutePath, prepared.data);
  return absolutePath;
}

export async function saveImage(postId: string, originalName: string, input: Buffer): Promise<MediaRow> {
  const prepared = await prepareImage(input);
  const duplicate = duplicateMedia(postId, prepared.sha256);
  if (duplicate) return duplicate;
  const mediaId = id('med');
  const absolutePath = await writePreparedFile(postId, mediaId, prepared);
  try {
    const saved = db.transaction(() => insertPreparedImage(postId, originalName, prepared, mediaId))();
    if (saved.id !== mediaId) await fs.unlink(absolutePath).catch(() => undefined);
    return saved;
  } catch (error) {
    await fs.unlink(absolutePath).catch(() => undefined);
    throw error;
  }
}

export async function saveImageVersioned(
  postId: string, originalName: string, input: Buffer, expectedContentVersion: number
): Promise<{ media: MediaRow; contentVersion: number }> {
  assertContentVersion(postId, expectedContentVersion);
  const prepared = await prepareImage(input);
  const duplicate = duplicateMedia(postId, prepared.sha256);
  if (duplicate) {
    assertContentVersion(postId, expectedContentVersion);
    return { media: duplicate, contentVersion: expectedContentVersion };
  }
  const mediaId = id('med');
  const absolutePath = await writePreparedFile(postId, mediaId, prepared);
  try {
    const committed = commitContentEdit(postId, expectedContentVersion, () =>
      insertPreparedImage(postId, originalName, prepared, mediaId));
    if (committed.value.id !== mediaId) await fs.unlink(absolutePath).catch(() => undefined);
    return { media: committed.value, contentVersion: committed.contentVersion };
  } catch (error) {
    await fs.unlink(absolutePath).catch(() => undefined);
    throw error;
  }
}

export async function saveVideoVersioned(
  postId: string,
  originalName: string,
  input: AsyncIterable<unknown>,
  expectedContentVersion: number
): Promise<{ media: MediaRow; poster: MediaRow; contentVersion: number }> {
  assertContentVersion(postId, expectedContentVersion);
  if (listMedia(postId).length !== 0) {
    throw new Error('Для Video v1 пост должен быть без других media. Удалите текущие изображения/видео перед загрузкой MP4.');
  }

  const preparedVideo = await prepareVideoUpload(originalName, input);
  let videoAbsolutePath: string | null = null;
  let posterAbsolutePath: string | null = null;
  try {
    const posterPrepared = await prepareImage(preparedVideo.posterData);
    const videoId = id('med');
    const posterId = id('med');
    const postDir = path.join(config.mediaDir, postId);
    const videoRelativePath = path.posix.join(postId, `${videoId}.mp4`);
    const posterRelativePath = path.posix.join(postId, `${posterId}.jpg`);
    videoAbsolutePath = path.join(config.mediaDir, videoRelativePath);
    posterAbsolutePath = path.join(config.mediaDir, posterRelativePath);

    await fs.mkdir(postDir, { recursive: true });
    await fs.rename(preparedVideo.tempVideoPath, videoAbsolutePath);
    await fs.writeFile(posterAbsolutePath, posterPrepared.data);

    const committed = commitContentEdit(postId, expectedContentVersion, () => {
      const createdAt = nowIso();
      db.prepare(`INSERT INTO media
        (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          posterId,
          postId,
          `${path.basename(originalName, path.extname(originalName))}.poster.jpg`,
          posterRelativePath,
          'image/jpeg',
          posterPrepared.data.byteLength,
          posterPrepared.width,
          posterPrepared.height,
          posterPrepared.sha256,
          createdAt,
          1
        );
      db.prepare(`INSERT INTO media
        (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order,
         duration_ms,fps,video_codec,audio_codec,container,poster_asset_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          videoId,
          postId,
          originalName,
          videoRelativePath,
          'video/mp4',
          preparedVideo.sizeBytes,
          preparedVideo.width,
          preparedVideo.height,
          preparedVideo.sha256,
          createdAt,
          0,
          preparedVideo.durationMs,
          preparedVideo.fps,
          preparedVideo.videoCodec,
          preparedVideo.audioCodec,
          preparedVideo.container,
          posterId
        );
      db.prepare("UPDATE posts SET publication_kind='FEED',content_format='VIDEO' WHERE id=?").run(postId);
      db.prepare("UPDATE content_media SET sort_order=0,role='video',updated_at=? WHERE post_id=? AND media_id=?")
        .run(createdAt, postId, videoId);
      db.prepare("UPDATE content_media SET sort_order=1,role='poster',updated_at=? WHERE post_id=? AND media_id=?")
        .run(createdAt, postId, posterId);
      return {
        media: db.prepare('SELECT * FROM media WHERE id=?').get(videoId) as MediaRow,
        poster: db.prepare('SELECT * FROM media WHERE id=?').get(posterId) as MediaRow
      };
    });
    return { ...committed.value, contentVersion: committed.contentVersion };
  } catch (error) {
    if (videoAbsolutePath) await fs.unlink(videoAbsolutePath).catch(() => undefined);
    if (posterAbsolutePath) await fs.unlink(posterAbsolutePath).catch(() => undefined);
    throw error;
  } finally {
    await preparedVideo.cleanup();
  }
}

export function listMedia(postId: string): MediaRow[] {
  return db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order ASC,created_at ASC').all(postId) as MediaRow[];
}

export function reorderMedia(postId: string, mediaIds: string[]): MediaRow[] {
  const current = listMedia(postId);
  if (current.length !== mediaIds.length) throw new Error('Порядок должен содержать все изображения поста');
  const expected = new Set(current.map((media) => media.id));
  const supplied = new Set(mediaIds);
  if (supplied.size !== mediaIds.length || supplied.size !== expected.size || mediaIds.some((mediaId) => !expected.has(mediaId))) {
    throw new Error('Список изображений для сортировки некорректен');
  }
  const update = db.prepare('UPDATE media SET sort_order=? WHERE id=? AND post_id=?');
  db.transaction(() => {
    mediaIds.forEach((mediaId, index) => update.run(index, mediaId, postId));
  })();
  return listMedia(postId);
}

export function mediaAbsolutePath(media: MediaRow): string {
  return path.join(config.mediaDir, media.relative_path);
}

export function mediaPublicUrl(media: MediaRow): string {
  if (!config.publicBaseUrl) throw new Error('PUBLIC_BASE_URL не настроен');
  return `${config.publicBaseUrl}/public-media/${media.relative_path.split('/').map(encodeURIComponent).join('/')}`;
}

function posterForVideo(media: MediaRow): MediaRow | undefined {
  if (!media.poster_asset_id) return undefined;
  const references = Number((db.prepare('SELECT COUNT(*) AS count FROM media WHERE poster_asset_id=? AND id<>?')
    .get(media.poster_asset_id, media.id) as { count: number }).count);
  if (references > 0) return undefined;
  return db.prepare('SELECT * FROM media WHERE id=? AND post_id=?').get(media.poster_asset_id, media.post_id) as MediaRow | undefined;
}

function normalizeRemainingMedia(postId: string): void {
  const rest = listMedia(postId);
  const update = db.prepare('UPDATE media SET sort_order=? WHERE id=?');
  rest.forEach((row, index) => update.run(index, row.id));
  const hasVideo = rest.some((row) => row.mime_type.startsWith('video/'));
  if (!hasVideo) {
    const imageFormat = rest.length > 1 ? 'CAROUSEL' : 'IMAGE';
    db.prepare("UPDATE posts SET publication_kind='FEED',content_format=? WHERE id=? AND content_format IN ('VIDEO','VERTICAL_VIDEO')")
      .run(imageFormat, postId);
    syncImageContentFormat(postId);
  }
}

export async function deleteMediaVersioned(mediaId: string, expectedContentVersion: number): Promise<{ postId: string; contentVersion: number }> {
  const media = db.prepare('SELECT * FROM media WHERE id=?').get(mediaId) as MediaRow | undefined;
  if (!media) throw new Error('Медиа не найдено');
  const poster = posterForVideo(media);
  const committed = commitContentEdit(media.post_id, expectedContentVersion, () => {
    db.prepare('DELETE FROM media WHERE id=?').run(mediaId);
    if (poster) db.prepare('DELETE FROM media WHERE id=?').run(poster.id);
    normalizeRemainingMedia(media.post_id);
    return media;
  });
  await fs.unlink(mediaAbsolutePath(media)).catch(() => undefined);
  if (poster) await fs.unlink(mediaAbsolutePath(poster)).catch(() => undefined);
  return { postId: media.post_id, contentVersion: committed.contentVersion };
}

export async function deleteMedia(mediaId: string): Promise<void> {
  const media = db.prepare('SELECT * FROM media WHERE id=?').get(mediaId) as MediaRow | undefined;
  if (!media) return;
  const poster = posterForVideo(media);
  db.transaction(() => {
    db.prepare('DELETE FROM media WHERE id=?').run(mediaId);
    if (poster) db.prepare('DELETE FROM media WHERE id=?').run(poster.id);
    normalizeRemainingMedia(media.post_id);
  })();
  await fs.unlink(mediaAbsolutePath(media)).catch(() => undefined);
  if (poster) await fs.unlink(mediaAbsolutePath(poster)).catch(() => undefined);
}
