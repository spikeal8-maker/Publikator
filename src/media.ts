import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from './config.js';
import { db, id, nowIso } from './db.js';

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
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
};

export async function saveImage(postId: string, originalName: string, input: Buffer): Promise<MediaRow> {
  if (input.byteLength > MAX_IMAGE_BYTES) throw new Error('Изображение больше 50 МБ');

  let normalized: Buffer;
  let width: number | null = null;
  let height: number | null = null;
  try {
    const source = sharp(input, { failOn: 'error' }).rotate();
    const sourceMetadata = await source.metadata();
    if (!sourceMetadata.width || !sourceMetadata.height) throw new Error('Файл не является корректным изображением');
    if (sourceMetadata.width > MAX_IMAGE_DIMENSION || sourceMetadata.height > MAX_IMAGE_DIMENSION) {
      throw new Error(`Изображение превышает ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}`);
    }
    const result = await source
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    normalized = result.data;
    width = result.info.width;
    height = result.info.height;
  } catch (error) {
    if (error instanceof Error && (error.message.includes('превышает') || error.message.includes('корректным изображением'))) throw error;
    throw new Error(`Не удалось обработать изображение: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (normalized.byteLength > MAX_IMAGE_BYTES) throw new Error('Нормализованное изображение больше 50 МБ');
  if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`Изображение превышает ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}`);
  }

  const sha256 = crypto.createHash('sha256').update(normalized).digest('hex');
  const duplicate = db.prepare('SELECT * FROM media WHERE post_id=? AND sha256=? ORDER BY sort_order,created_at LIMIT 1')
    .get(postId, sha256) as MediaRow | undefined;
  if (duplicate) return duplicate;

  const mediaId = id('med');
  const postDir = path.join(config.mediaDir, postId);
  await fs.mkdir(postDir, { recursive: true });
  const relativePath = path.posix.join(postId, `${mediaId}.jpg`);
  const absolutePath = path.join(config.mediaDir, relativePath);
  const nextOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM media WHERE post_id=?')
    .get(postId) as { next_order: number }).next_order;
  const createdAt = nowIso();

  await fs.writeFile(absolutePath, normalized);
  try {
    db.prepare(`INSERT INTO media
      (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(mediaId, postId, originalName, relativePath, 'image/jpeg', normalized.byteLength, width, height, sha256, createdAt, nextOrder);
  } catch (error) {
    await fs.unlink(absolutePath).catch(() => undefined);
    throw error;
  }

  return db.prepare('SELECT * FROM media WHERE id=?').get(mediaId) as MediaRow;
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

export async function deleteMedia(mediaId: string): Promise<void> {
  const media = db.prepare('SELECT * FROM media WHERE id=?').get(mediaId) as MediaRow | undefined;
  if (!media) return;
  db.prepare('DELETE FROM media WHERE id=?').run(mediaId);
  await fs.unlink(mediaAbsolutePath(media)).catch(() => undefined);

  const rest = listMedia(media.post_id);
  const update = db.prepare('UPDATE media SET sort_order=? WHERE id=?');
  db.transaction(() => {
    rest.forEach((row, index) => update.run(index, row.id));
  })();
}
