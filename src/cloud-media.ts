import { db } from './db.js';
import { parseCloudMediaReferences, type CloudMediaReference } from './cloud-media-reference.js';
import {
  downloadGoogleDriveMedia,
  resolveGoogleDriveMedia,
  type DownloadedCloudMedia as DownloadedGoogleDriveMedia,
  type ResolvedGoogleDriveMedia
} from './google-drive-media.js';
import {
  downloadYandexDiskMedia,
  resolveYandexDiskMedia,
  type DownloadedYandexDiskMedia,
  type ResolvedYandexDiskMedia
} from './yandex-disk-media.js';

export type ResolvedCloudMedia = ResolvedGoogleDriveMedia | ResolvedYandexDiskMedia;
export type DownloadedCloudMedia = DownloadedGoogleDriveMedia | DownloadedYandexDiskMedia;
export type CloudMediaPreview = {
  managed: boolean;
  references: CloudMediaReference[];
  resolved: ResolvedCloudMedia[];
};

type ConnectorLookup = { id: string; type: string; name: string };

function connectorBySource(source: string): ConnectorLookup {
  const rows = db.prepare(`SELECT id,type,name FROM ingestion_connectors
    WHERE enabled=1 AND name=? AND type IN ('google_drive','yandex_disk') ORDER BY id`).all(source) as ConnectorLookup[];
  if (rows.length === 0) throw new Error(`Cloud media source not found or disabled: ${source}`);
  if (rows.length > 1) throw new Error(`Cloud media source name is ambiguous: ${source}`);
  return rows[0]!;
}
export async function resolveCloudMediaCell(cell: unknown): Promise<CloudMediaPreview> {
  const parsed = parseCloudMediaReferences(cell);
  if (!parsed.managed) return { managed: false, references: [], resolved: [] };
  const resolved: ResolvedCloudMedia[] = [];
  for (const reference of parsed.references) {
    const connector = connectorBySource(reference.source);
    if (connector.type === 'google_drive') {
      resolved.push(await resolveGoogleDriveMedia(connector.id, reference.path));
      continue;
    }
    if (connector.type === 'yandex_disk') {
      resolved.push(await resolveYandexDiskMedia(connector.id, reference.path));
      continue;
    }
    throw new Error(`Cloud media provider is not implemented: ${connector.type}`);
  }
  if (resolved.some((item) => item.mimeType === 'video/mp4')) {
    throw new Error('Cloud video media binding is not enabled yet; use image files');
  }
  if (resolved.some((item) => !item.mimeType.startsWith('image/'))) {
    throw new Error('Cloud media binding currently supports image files only');
  }
  return { managed: true, references: parsed.references, resolved };
}

export async function refreshCloudMedia(resolved: ResolvedCloudMedia): Promise<ResolvedCloudMedia> {
  if (resolved.provider === 'google_drive') return resolveGoogleDriveMedia(resolved.connectorId, resolved.path);
  if (resolved.provider === 'yandex_disk') return resolveYandexDiskMedia(resolved.connectorId, resolved.path);
  throw new Error(`Unsupported cloud media provider: ${(resolved as any).provider}`);
}

export async function downloadCloudMedia(resolved: ResolvedCloudMedia): Promise<DownloadedCloudMedia> {
  if (resolved.provider === 'google_drive') return downloadGoogleDriveMedia(resolved);
  if (resolved.provider === 'yandex_disk') return downloadYandexDiskMedia(resolved);
  throw new Error(`Unsupported cloud media provider: ${(resolved as any).provider}`);
}
