import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, event } from './db.js';
import {
  createIngestionConnector,
  readIngestionConnectorCredentials,
  type ConnectorMetadata
} from './integration-security.js';
import {
  googleBearerHeaders,
  googleFetchWithTimeout,
  googleServiceAccountAccessToken,
  normalizeGoogleServiceAccount
} from './google-service-account.js';

const GOOGLE_DRIVE_ROOT = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const REQUEST_TIMEOUT_MS = 20_000;

export type GoogleDriveMediaConfig = {
  rootFolderId: string;
  rootFolderName: string;
  serviceAccountEmail: string;
};

type ConnectorRow = {
  id: string;
  type: string;
  name: string;
  config_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  parents?: string[];
  capabilities?: { canDownload?: boolean };
};

export type ResolvedGoogleDriveMedia = {
  provider: 'google_drive';
  connectorId: string;
  connectorName: string;
  path: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  revision: string;
};

export type DownloadedCloudMedia = ResolvedGoogleDriveMedia & {
  tempPath: string;
  sha256: string;
  cleanup: () => Promise<void>;
};

function normalizeFolderId(value: unknown): string {
  const raw = String(value ?? '').trim();
  const urlMatch = raw.match(/^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,200})(?:[/?#].*)?$/i);
  const folderId = urlMatch?.[1] ?? raw;
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(folderId)) throw new Error('Google Drive root folder must be a folder ID or drive.google.com/drive/folders/... URL');
  return folderId;
}

function normalizeConfig(value: unknown): GoogleDriveMediaConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Google Drive connector config is invalid');
  const row = value as Record<string, unknown>;
  const rootFolderId = normalizeFolderId(row.rootFolderId);
  const rootFolderName = String(row.rootFolderName ?? '').trim();
  const serviceAccountEmail = String(row.serviceAccountEmail ?? '').trim();
  return { rootFolderId, rootFolderName, serviceAccountEmail };
}

function connectorMetadata(row: ConnectorRow): ConnectorMetadata & { config: GoogleDriveMediaConfig } {
  return {
    id: row.id,
    type: 'google_drive',
    name: row.name,
    config: normalizeConfig(JSON.parse(row.config_json)),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function connectorRow(connectorId: string, requireEnabled = true): ConnectorRow {
  const row = db.prepare(`SELECT id,type,name,config_json,enabled,created_at,updated_at FROM ingestion_connectors
    WHERE id=? AND type='google_drive'`).get(connectorId) as ConnectorRow | undefined;
  if (!row || (requireEnabled && !row.enabled)) throw new Error('Enabled Google Drive connector not found');
  return row;
}

function qEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function driveJson(url: string, token: string): Promise<any> {
  const response = await googleFetchWithTimeout(url, { headers: googleBearerHeaders(token) }, REQUEST_TIMEOUT_MS);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google Drive API failed (HTTP ${response.status})`);
  return payload;
}

async function fileMetadata(token: string, fileId: string): Promise<DriveFile> {
  const query = new URLSearchParams({
    fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,parents,capabilities(canDownload)',
    supportsAllDrives: 'true'
  });
  return await driveJson(`${GOOGLE_DRIVE_ROOT}/${encodeURIComponent(fileId)}?${query}`, token) as DriveFile;
}

async function inspectRoot(credentialsRaw: unknown, rootFolderRaw: unknown): Promise<{ rootFolderId: string; rootFolderName: string; serviceAccountEmail: string }> {
  const credentials = normalizeGoogleServiceAccount(credentialsRaw);
  const rootFolderId = normalizeFolderId(rootFolderRaw);
  const token = await googleServiceAccountAccessToken(credentials, DRIVE_READ_SCOPE);
  const root = await fileMetadata(token, rootFolderId);
  if (root.mimeType !== GOOGLE_FOLDER_MIME) throw new Error('Configured Google Drive root is not a folder');
  return { rootFolderId, rootFolderName: root.name || rootFolderId, serviceAccountEmail: credentials.client_email };
}

export async function inspectGoogleDriveMedia(credentials: unknown, rootFolder: unknown): Promise<{ rootFolderId: string; rootFolderName: string; serviceAccountEmail: string }> {
  return inspectRoot(credentials, rootFolder);
}

export function listGoogleDriveMediaConnectors(): Array<ConnectorMetadata & { config: GoogleDriveMediaConfig }> {
  return (db.prepare(`SELECT id,type,name,config_json,enabled,created_at,updated_at FROM ingestion_connectors
    WHERE type='google_drive' ORDER BY created_at,id`).all() as ConnectorRow[]).map(connectorMetadata);
}

export async function createGoogleDriveMediaConnector(params: {
  name: string;
  rootFolder: unknown;
  credentials: unknown;
}): Promise<ConnectorMetadata & { config: GoogleDriveMediaConfig }> {
  const inspection = await inspectRoot(params.credentials, params.rootFolder);
  const credentials = normalizeGoogleServiceAccount(params.credentials);
  const created = createIngestionConnector({
    type: 'google_drive',
    name: params.name,
    config: inspection,
    credentials
  });
  return { ...created, config: inspection };
}

export async function testGoogleDriveMediaConnector(connectorId: string): Promise<{ rootFolderId: string; rootFolderName: string; serviceAccountEmail: string }> {
  const row = connectorRow(connectorId);
  const connector = connectorMetadata(row);
  const credentials = readIngestionConnectorCredentials(connectorId);
  const inspected = await inspectRoot(credentials, connector.config.rootFolderId);
  if (inspected.rootFolderId !== connector.config.rootFolderId) throw new Error('Google Drive root folder changed unexpectedly');
  return inspected;
}

async function exactChild(token: string, parentId: string, name: string): Promise<DriveFile> {
  const params = new URLSearchParams({
    q: `'${qEscape(parentId)}' in parents and name = '${qEscape(name)}' and trashed = false`,
    fields: 'files(id,name,mimeType,size,md5Checksum,modifiedTime,parents,capabilities(canDownload))',
    spaces: 'drive',
    pageSize: '100',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  const payload = await driveJson(`${GOOGLE_DRIVE_ROOT}?${params}`, token) as { files?: DriveFile[] };
  const files = Array.isArray(payload.files) ? payload.files.filter((file) => file.name === name) : [];
  if (files.length === 0) throw new Error(`Google Drive media not found: ${name}`);
  if (files.length > 1) throw new Error(`Google Drive media path is ambiguous: ${name}`);
  return files[0]!;
}

function mediaLimit(mimeType: string): number {
  if (mimeType.startsWith('image/')) return config.maxImageBytes;
  if (mimeType === 'video/mp4') return config.maxVideoBytes;
  throw new Error(`Google Drive media type is not supported: ${mimeType}`);
}

export async function resolveGoogleDriveMedia(connectorId: string, relativePath: string): Promise<ResolvedGoogleDriveMedia> {
  const row = connectorRow(connectorId);
  const connector = connectorMetadata(row);
  const credentials = readIngestionConnectorCredentials(connectorId);
  const token = await googleServiceAccountAccessToken(credentials, DRIVE_READ_SCOPE);
  const segments = relativePath.split('/');
  let parentId = connector.config.rootFolderId;
  let file: DriveFile | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    file = await exactChild(token, parentId, segments[index]!);
    if (index < segments.length - 1) {
      if (file.mimeType !== GOOGLE_FOLDER_MIME) throw new Error(`Google Drive path segment is not a folder: ${segments[index]}`);
      parentId = file.id;
    }
  }
  if (!file || file.mimeType === GOOGLE_FOLDER_MIME || file.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new Error(`Google Drive path does not resolve to a downloadable media file: ${relativePath}`);
  }
  if (file.capabilities?.canDownload === false) throw new Error(`Google Drive file cannot be downloaded: ${relativePath}`);
  const sizeBytes = Number(file.size ?? 0);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new Error(`Google Drive file size is unavailable: ${relativePath}`);
  const limit = mediaLimit(file.mimeType);
  if (sizeBytes > limit) throw new Error(`Google Drive file exceeds Publikator media limit: ${relativePath}`);
  const revision = file.md5Checksum || `${file.modifiedTime ?? ''}:${sizeBytes}:${file.id}`;
  return {
    provider: 'google_drive',
    connectorId,
    connectorName: row.name,
    path: relativePath,
    fileId: file.id,
    fileName: file.name,
    mimeType: file.mimeType,
    sizeBytes,
    revision
  };
}

export async function downloadGoogleDriveMedia(resolved: ResolvedGoogleDriveMedia): Promise<DownloadedCloudMedia> {
  const row = connectorRow(resolved.connectorId);
  const credentials = readIngestionConnectorCredentials(resolved.connectorId);
  const token = await googleServiceAccountAccessToken(credentials, DRIVE_READ_SCOPE);
  const query = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
  const response = await googleFetchWithTimeout(`${GOOGLE_DRIVE_ROOT}/${encodeURIComponent(resolved.fileId)}?${query}`, {
    headers: googleBearerHeaders(token)
  }, config.mediaProcessingTimeoutMs);
  if (!response.ok || !response.body) throw new Error(`Google Drive media download failed (HTTP ${response.status})`);
  const limit = mediaLimit(resolved.mimeType);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error(`Google Drive media response exceeds Publikator media limit: ${resolved.path}`);
  await fs.mkdir(config.mediaTempDir, { recursive: true });
  const tempPath = path.join(config.mediaTempDir, `.gdrive-${crypto.randomUUID()}`);
  const handle = await fs.open(tempPath, 'wx');
  const hash = crypto.createHash('sha256');
  let total = 0;
  try {
    for await (const value of response.body as any as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > limit) throw new Error(`Google Drive media response exceeds Publikator media limit: ${resolved.path}`);
      hash.update(chunk);
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  if (total < 1) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error(`Google Drive returned an empty file: ${resolved.path}`);
  }
  event({ type: 'google_drive.media_downloaded', message: `Google Drive media downloaded: ${resolved.path}`, data: { connectorId: row.id, fileId: resolved.fileId, sizeBytes: total } });
  return {
    ...resolved,
    tempPath,
    sha256: hash.digest('hex'),
    cleanup: async () => { await fs.rm(tempPath, { force: true }).catch(() => undefined); }
  };
}
