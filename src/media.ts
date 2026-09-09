import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from './config.js';
import { db, id, nowIso } from './db.js';

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
};

export async function saveImage(postId: string, originalName: string, input: Buffer): Promise<MediaRow> {
  if (input.byteLength > 50 * 1024 * 1024) throw new Error('Изображение больше 50 МБ');
  const mediaId = id('med');
  const postDir = path.join(config.mediaDir, postId);
  await fs.mkdir(postDir, { recursive: true });
  const relativePath = path.posix.join(postId, `${mediaId}.jpg`);
  const absolutePath = path.join(config.mediaDir, relativePath);

  const image = sharp(input, { failOn: 'error' }).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Файл не является корректным изображением');
  if (metadata.width > 7680 || metadata.height > 7680) throw new Error('Изображение превышает 7680×7680');

  await image.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toFile(absolutePath);
  const normalized = await fs.readFile(absolutePath);
  const normalizedMeta = await sharp(normalized).metadata();
  const sha256 = crypto.createHash('sha256').update(normalized).digest('hex');
  const createdAt = nowIso();

  db.prepare(`INSERT INTO media
    (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(mediaId, postId, originalName, relativePath, 'image/jpeg', normalized.byteLength, normalizedMeta.width ?? null, normalizedMeta.height ?? null, sha256, createdAt);

  return db.prepare('SELECT * FROM media WHERE id=?').get(mediaId) as MediaRow;
}

export function listMedia(postId: string): MediaRow[] {
  return db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY created_at ASC').all(postId) as MediaRow[];
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
}
