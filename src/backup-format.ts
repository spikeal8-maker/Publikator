import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import * as tar from 'tar';
import { config } from './config.js';
import { DATABASE_SCHEMA_VERSION } from './schema.js';

export const BACKUP_FORMAT = 'publikator-backup';
export const BACKUP_FORMAT_VERSION = 1;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024 * 1024;

export type BackupMediaEntry = {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
};

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  label: string;
  masterKeyFingerprint: string;
  databaseFile: 'publikator.sqlite';
  databaseSha256: string;
  mediaDirectory: 'media';
  counts: {
    projects: number;
    posts: number;
    socialAccounts: number;
    media: number;
  };
  mediaFiles: BackupMediaEntry[];
};

export function masterKeyFingerprint(): string {
  return crypto.createHash('sha256').update(config.masterKey, 'utf8').digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function appVersion(): Promise<string> {
  const raw = await fs.readFile(path.resolve('package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || !parsed.version.trim()) throw new Error('package.json не содержит version');
  return parsed.version.trim();
}

export function safeMediaRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) throw new Error(`Некорректный media path: ${relativePath}`);
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error(`Некорректный media path: ${relativePath}`);
  return normalized;
}

function canonicalArchiveEntry(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) throw new Error(`Backup содержит небезопасный path: ${entryPath}`);
  const segments = normalized.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) throw new Error(`Backup содержит небезопасный path: ${entryPath}`);
  if (normalized !== 'manifest.json' && normalized !== 'publikator.sqlite' && normalized !== 'media' && !normalized.startsWith('media/')) {
    throw new Error(`Backup содержит неизвестный entry: ${entryPath}`);
  }
  return normalized;
}

export async function extractBackupArchive(archivePath: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const seen = new Set<string>();
  let entries = 0;
  let expandedBytes = 0;
  await tar.extract({
    file: archivePath,
    cwd: destination,
    strict: true,
    preservePaths: false,
    filter: (entryPath, entry) => {
      const canonical = canonicalArchiveEntry(entryPath);
      if (seen.has(canonical)) throw new Error(`Backup содержит повторяющийся entry: ${canonical}`);
      seen.add(canonical);
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) throw new Error(`Backup содержит больше ${MAX_ARCHIVE_ENTRIES} entries`);

      const type = String((entry as { type?: string }).type || '');
      if (!['File', 'OldFile', 'ContiguousFile', 'Directory'].includes(type)) {
        throw new Error(`Backup содержит запрещённый тип entry ${type || 'unknown'}: ${canonical}`);
      }
      if (type !== 'Directory') {
        const size = Number((entry as { size?: number }).size || 0);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Backup содержит некорректный размер entry: ${canonical}`);
        expandedBytes += size;
        if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('Распакованный backup превышает безопасный лимит 16 ГБ');
      }
      return true;
    }
  });
}

function readCount(database: Database.Database, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

async function walkFiles(root: string, relative = ''): Promise<string[]> {
  const directory = path.join(root, ...relative.split('/').filter(Boolean));
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Backup media содержит symlink: ${child}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) files.push(safeMediaRelativePath(child));
    else throw new Error(`Backup media содержит неподдерживаемый filesystem entry: ${child}`);
  }
  return files.sort();
}

export async function validateBackupDirectory(directory: string): Promise<BackupManifest> {
  const manifestPath = path.join(directory, 'manifest.json');
  const manifestStat = await fs.stat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile()) throw new Error('Backup bundle не содержит manifest.json');
  if (manifestStat.size > 10 * 1024 * 1024) throw new Error('manifest.json слишком большой');

  let manifest: Partial<BackupManifest>;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Partial<BackupManifest>;
  } catch (error) {
    throw new Error(`manifest.json повреждён: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error('Неподдерживаемый формат backup bundle');
  }
  if (!Number.isInteger(manifest.schemaVersion) || Number(manifest.schemaVersion) < 1) throw new Error('Backup bundle не содержит корректную schemaVersion');
  if (Number(manifest.schemaVersion) > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Backup создан более новой схемой (${manifest.schemaVersion}), текущая поддерживает ${DATABASE_SCHEMA_VERSION}`);
  }
  if (manifest.masterKeyFingerprint !== masterKeyFingerprint()) {
    throw new Error('APP_MASTER_KEY не совпадает с ключом, которым был создан backup. Восстановление заблокировано, чтобы не потерять доступ к зашифрованным credentials.');
  }
  if (manifest.databaseFile !== 'publikator.sqlite' || manifest.mediaDirectory !== 'media') throw new Error('Backup bundle содержит неизвестную структуру');
  if (typeof manifest.databaseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.databaseSha256)) throw new Error('Некорректный databaseSha256');
  if (!Array.isArray(manifest.mediaFiles)) throw new Error('Backup bundle не содержит mediaFiles');

  const databasePath = path.join(directory, 'publikator.sqlite');
  const databaseStat = await fs.stat(databasePath).catch(() => null);
  if (!databaseStat?.isFile()) throw new Error('Backup bundle не содержит publikator.sqlite');
  const databaseHash = await sha256File(databasePath);
  if (databaseHash !== manifest.databaseSha256) throw new Error('Контрольная сумма SQLite в backup bundle не совпадает');

  const snapshot = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(snapshot.pragma('integrity_check', { simple: true }));
    if (integrity.toLowerCase() !== 'ok') throw new Error(`SQLite integrity_check: ${integrity}`);
    const tables = new Set((snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
    const requiredTables = ['projects', 'social_accounts', 'posts', 'media', 'post_targets', 'schedule_slots', 'publication_events'];
    if (Number(manifest.schemaVersion) >= 2) requiredTables.push('release_acceptance');
    if (Number(manifest.schemaVersion) >= 4) requiredTables.push('content_revisions');
    if (Number(manifest.schemaVersion) >= 6) requiredTables.push('integration_api_keys', 'ingestion_connectors');
    for (const required of requiredTables) {
      if (!tables.has(required)) throw new Error(`SQLite backup не содержит таблицу ${required}`);
    }
    const schemaVersion = Number(snapshot.pragma('user_version', { simple: true }));
    if (schemaVersion !== Number(manifest.schemaVersion)) throw new Error(`schemaVersion manifest (${manifest.schemaVersion}) не совпадает с SQLite (${schemaVersion})`);

    const mediaRows = snapshot.prepare('SELECT relative_path,size_bytes,sha256 FROM media ORDER BY relative_path').all() as Array<{ relative_path: string; size_bytes: number; sha256: string }>;
    if (mediaRows.length !== manifest.mediaFiles.length) throw new Error('Количество media в manifest не совпадает с SQLite');
    const manifestMedia = new Map<string, BackupMediaEntry>();
    for (const rawItem of manifest.mediaFiles) {
      if (!rawItem || typeof rawItem !== 'object') throw new Error('manifest содержит некорректный media entry');
      const relativePath = safeMediaRelativePath(String(rawItem.relativePath));
      const sizeBytes = Number(rawItem.sizeBytes);
      const sha256 = String(rawItem.sha256);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`manifest содержит некорректную metadata для ${relativePath}`);
      if (manifestMedia.has(relativePath)) throw new Error(`manifest содержит повторяющийся media path ${relativePath}`);
      manifestMedia.set(relativePath, { relativePath, sizeBytes, sha256 });
    }

    for (const row of mediaRows) {
      const relativePath = safeMediaRelativePath(row.relative_path);
      const expected = manifestMedia.get(relativePath);
      if (!expected) throw new Error(`manifest не содержит media ${relativePath}`);
      if (expected.sizeBytes !== Number(row.size_bytes) || expected.sha256 !== String(row.sha256)) {
        throw new Error(`manifest metadata не совпадает с SQLite для ${relativePath}`);
      }
      const filePath = path.join(directory, 'media', ...relativePath.split('/'));
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) throw new Error(`Backup bundle не содержит media/${relativePath}`);
      if (stat.size !== Number(row.size_bytes)) throw new Error(`Размер media/${relativePath} не совпадает с SQLite`);
      const hash = await sha256File(filePath);
      if (hash !== row.sha256) throw new Error(`SHA-256 media/${relativePath} не совпадает с SQLite`);
    }

    const extractedMediaFiles = await walkFiles(path.join(directory, 'media'));
    const expectedMediaFiles = [...manifestMedia.keys()].sort();
    if (extractedMediaFiles.length !== expectedMediaFiles.length || extractedMediaFiles.some((file, index) => file !== expectedMediaFiles[index])) {
      throw new Error('Backup media содержит лишние или отсутствующие файлы');
    }

    if (!manifest.counts ||
      Number(manifest.counts.projects) !== readCount(snapshot, 'projects') ||
      Number(manifest.counts.posts) !== readCount(snapshot, 'posts') ||
      Number(manifest.counts.socialAccounts) !== readCount(snapshot, 'social_accounts') ||
      Number(manifest.counts.media) !== readCount(snapshot, 'media')) {
      throw new Error('Счётчики manifest не совпадают с SQLite');
    }
  } finally {
    snapshot.close();
  }

  return manifest as BackupManifest;
}
