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

const YANDEX_DISK_ROOT = 'https://cloud-api.yandex.net/v1/disk';
const REQUEST_TIMEOUT_MS = 20_000;

export type YandexDiskMediaConfig = {
  rootPath: string;
  rootFolderName: string;
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

type YandexCredentials = { oauthToken: string };
type YandexResource = {
  name?: string;
  path?: string;
  type?: 'dir' | 'file';
  mime_type?: string;
  size?: number;
  md5?: string;
  sha256?: string;
  modified?: string;
  resource_id?: string;
};

export type ResolvedYandexDiskMedia = {
  provider: 'yandex_disk';
  connectorId: string;
  connectorName: string;
  path: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  revision: string;
};

export type DownloadedYandexDiskMedia = ResolvedYandexDiskMedia & {
  tempPath: string;
  sha256: string;
  cleanup: () => Promise<void>;
};

function normalizeCredentials(value: unknown): YandexCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Yandex Disk credentials must be an object');
  const token = String((value as Record<string, unknown>).oauthToken ?? '').trim();
  if (token.length < 20 || token.length > 4096 || /\s/.test(token)) throw new Error('Yandex Disk OAuth token is invalid');
  return { oauthToken: token };
}

function normalizeRootPath(value: unknown): string {
  let raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw) throw new Error('Yandex Disk root path is required');
  if (raw.startsWith('disk:')) raw = raw.slice(5);
  if (!raw.startsWith('/')) raw = `/${raw}`;
  raw = raw.replace(/\/{2,}/g, '/');
  if (raw.length > 1024 || raw.includes('/../') || raw.endsWith('/..') || raw.includes('/./') || raw.endsWith('/.')) {
    throw new Error('Yandex Disk root path is invalid');
  }
  return `disk:${raw.length > 1 ? raw.replace(/\/$/, '') : '/'}`;
}

function normalizeConfig(value: unknown): YandexDiskMediaConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Yandex Disk connector config is invalid');
  const row = value as Record<string, unknown>;
  return {
    rootPath: normalizeRootPath(row.rootPath),
    rootFolderName: String(row.rootFolderName ?? '').trim()
  };
}

function connectorRow(connectorId: string, requireEnabled = true): ConnectorRow {
  const row = db.prepare(`SELECT id,type,name,config_json,enabled,created_at,updated_at FROM ingestion_connectors
    WHERE id=? AND type='yandex_disk'`).get(connectorId) as ConnectorRow | undefined;
  if (!row || (requireEnabled && !row.enabled)) throw new Error('Enabled Yandex Disk connector not found');
  return row;
}

function connectorMetadata(row: ConnectorRow): ConnectorMetadata & { config: YandexDiskMediaConfig } {
  return {
    id: row.id,
    type: 'yandex_disk',
    name: row.name,
    config: normalizeConfig(JSON.parse(row.config_json)),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function authHeaders(token: string): HeadersInit {
  return { authorization: `OAuth ${token}`, accept: 'application/json' };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Yandex Disk API request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function apiJson(url: string, token: string): Promise<any> {
  const response = await fetchWithTimeout(url, { headers: authHeaders(token) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Yandex Disk API failed (HTTP ${response.status})`);
  return payload;
}

async function resourceMetadata(token: string, diskPath: string): Promise<YandexResource> {
  const params = new URLSearchParams({
    path: diskPath,
    fields: 'name,path,type,mime_type,size,md5,sha256,modified,resource_id'
  });
  return await apiJson(`${YANDEX_DISK_ROOT}/resources?${params}`, token) as YandexResource;
}

async function inspectRoot(credentialsRaw: unknown, rootPathRaw: unknown): Promise<{ rootPath: string; rootFolderName: string }> {
  const credentials = normalizeCredentials(credentialsRaw);
  const rootPath = normalizeRootPath(rootPathRaw);
  const resource = await resourceMetadata(credentials.oauthToken, rootPath);
  if (resource.type !== 'dir') throw new Error('Configured Yandex Disk root is not a folder');
  return { rootPath, rootFolderName: resource.name || rootPath };
}

export async function inspectYandexDiskMedia(credentials: unknown, rootPath: unknown): Promise<{ rootPath: string; rootFolderName: string }> {
  return inspectRoot(credentials, rootPath);
}

export function listYandexDiskMediaConnectors(): Array<ConnectorMetadata & { config: YandexDiskMediaConfig }> {
  return (db.prepare(`SELECT id,type,name,config_json,enabled,created_at,updated_at FROM ingestion_connectors
    WHERE type='yandex_disk' ORDER BY created_at,id`).all() as ConnectorRow[]).map(connectorMetadata);
}

export async function createYandexDiskMediaConnector(params: {
  name: string;
  rootPath: unknown;
  credentials: unknown;
}): Promise<ConnectorMetadata & { config: YandexDiskMediaConfig }> {
  const inspection = await inspectRoot(params.credentials, params.rootPath);
  const credentials = normalizeCredentials(params.credentials);
  const created = createIngestionConnector({
    type: 'yandex_disk',
    name: params.name,
    config: inspection,
    credentials
  });
  return { ...created, config: inspection };
}

export async function testYandexDiskMediaConnector(connectorId: string): Promise<{ rootPath: string; rootFolderName: string }> {
  const row = connectorRow(connectorId);
  const connector = connectorMetadata(row);
  const credentials = readIngestionConnectorCredentials(connectorId);
  const inspected = await inspectRoot(credentials, connector.config.rootPath);
  if (inspected.rootPath !== connector.config.rootPath) throw new Error('Yandex Disk root path changed unexpectedly');
  return inspected;
}

function mediaLimit(mimeType: string): number {
  if (mimeType.startsWith('image/')) return config.maxImageBytes;
  if (mimeType === 'video/mp4') return config.maxVideoBytes;
  throw new Error(`Yandex Disk media type is not supported: ${mimeType}`);
}

function fullPath(rootPath: string, relativePath: string): string {
  const root = rootPath === 'disk:/' ? 'disk:' : rootPath.replace(/\/$/, '');
  return `${root}/${relativePath}`;
}

export async function resolveYandexDiskMedia(connectorId: string, relativePath: string): Promise<ResolvedYandexDiskMedia> {
  const row = connectorRow(connectorId);
  const connector = connectorMetadata(row);
  const credentials = normalizeCredentials(readIngestionConnectorCredentials(connectorId));
  const diskPath = fullPath(connector.config.rootPath, relativePath);
  const resource = await resourceMetadata(credentials.oauthToken, diskPath);
  if (resource.type !== 'file') throw new Error(`Yandex Disk path does not resolve to a media file: ${relativePath}`);
  const mimeType = String(resource.mime_type ?? '').trim();
  if (!mimeType) throw new Error(`Yandex Disk media MIME type is unavailable: ${relativePath}`);
  const sizeBytes = Number(resource.size ?? 0);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new Error(`Yandex Disk file size is unavailable: ${relativePath}`);
  const limit = mediaLimit(mimeType);
  if (sizeBytes > limit) throw new Error(`Yandex Disk file exceeds Publikator media limit: ${relativePath}`);
  const fileName = String(resource.name ?? relativePath.split('/').at(-1) ?? '').trim();
  if (!fileName) throw new Error(`Yandex Disk file name is unavailable: ${relativePath}`);
  const fileId = String(resource.resource_id ?? resource.path ?? diskPath);
  const revision = String(resource.md5 ?? resource.sha256 ?? `${resource.modified ?? ''}:${sizeBytes}:${fileId}`);
  return {
    provider: 'yandex_disk',
    connectorId,
    connectorName: row.name,
    path: relativePath,
    fileId,
    fileName,
    mimeType,
    sizeBytes,
    revision
  };
}

function assertDownloadUrl(raw: unknown): string {
  const url = new URL(String(raw ?? ''));
  if (url.protocol !== 'https:') throw new Error('Yandex Disk returned a non-HTTPS download URL');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') throw new Error('Yandex Disk returned an unsafe download URL');
  return url.toString();
}

export async function downloadYandexDiskMedia(resolved: ResolvedYandexDiskMedia): Promise<DownloadedYandexDiskMedia> {
  const credentials = normalizeCredentials(readIngestionConnectorCredentials(resolved.connectorId));
  const connector = connectorMetadata(connectorRow(resolved.connectorId));
  const diskPath = fullPath(connector.config.rootPath, resolved.path);
  const params = new URLSearchParams({ path: diskPath });
  const link = await apiJson(`${YANDEX_DISK_ROOT}/resources/download?${params}`, credentials.oauthToken) as { href?: string; method?: string };
  if (link.method && String(link.method).toUpperCase() !== 'GET') throw new Error('Yandex Disk returned an unsupported download method');
  const href = assertDownloadUrl(link.href);
  const response = await fetchWithTimeout(href, { headers: { accept: '*/*' } }, config.mediaProcessingTimeoutMs);
  if (!response.ok || !response.body) throw new Error(`Yandex Disk media download failed (HTTP ${response.status})`);
  const limit = mediaLimit(resolved.mimeType);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error(`Yandex Disk media response exceeds Publikator media limit: ${resolved.path}`);
  await fs.mkdir(config.mediaTempDir, { recursive: true });
  const tempPath = path.join(config.mediaTempDir, `.ydisk-${crypto.randomUUID()}`);
  const handle = await fs.open(tempPath, 'wx');
  const hash = crypto.createHash('sha256');
  let total = 0;
  try {
    for await (const value of response.body as any as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > limit) throw new Error(`Yandex Disk media response exceeds Publikator media limit: ${resolved.path}`);
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
    throw new Error(`Yandex Disk returned an empty file: ${resolved.path}`);
  }
  event({ type: 'yandex_disk.media_downloaded', message: `Yandex Disk media downloaded: ${resolved.path}`, data: { connectorId: resolved.connectorId, fileId: resolved.fileId, sizeBytes: total } });
  return {
    ...resolved,
    tempPath,
    sha256: hash.digest('hex'),
    cleanup: async () => { await fs.rm(tempPath, { force: true }).catch(() => undefined); }
  };
}
