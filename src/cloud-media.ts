import { db } from './db.js';
import { parseCloudMediaReferences, type CloudMediaReference } from './cloud-media-reference.js';
import {
  downloadGoogleDriveMedia,
  resolveGoogleDriveMedia,
  type DownloadedCloudMedia,
  type ResolvedGoogleDriveMedia
} from './google-drive-media.js';

export type ResolvedCloudMedia = ResolvedGoogleDriveMedia;
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
    throw new Error(`Cloud media provider is not implemented in CP2-006A: ${connector.type}`);
  }
  const videoCount = resolved.filter((item) => item.mimeType === 'video/mp4').length;
  if (videoCount > 0) throw new Error('Google Drive video media binding is not enabled in CP2-006A; use image files for this checkpoint');
  if (resolved.some((item) => !item.mimeType.startsWith('image/'))) throw new Error('CP2-006A cloud media binding supports image files only');
  return { managed: true, references: parsed.references, resolved };
}

export async function downloadCloudMedia(resolved: ResolvedCloudMedia): Promise<DownloadedCloudMedia> {
  if (resolved.provider === 'google_drive') return downloadGoogleDriveMedia(resolved);
  throw new Error(`Unsupported cloud media provider: ${(resolved as any).provider}`);
}
