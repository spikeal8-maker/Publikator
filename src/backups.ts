import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import * as tar from 'tar';
import { config } from './config.js';
import { db } from './db.js';
import { beginMaintenance } from './runtime-gate.js';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  appVersion,
  extractBackupArchive,
  masterKeyFingerprint,
  safeMediaRelativePath,
  sha256File,
  validateBackupDirectory,
  type BackupManifest,
  type BackupMediaEntry
} from './backup-format.js';

export type BackupListItem = {
  name: string;
  sizeBytes: number;
  createdAt: string;
};

let bundleOperationInProgress = false;

function sanitizeLabel(label: string): string {
  const cleaned = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'manual';
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function snapshotCount(snapshot: Database.Database, table: string): number {
  return Number((snapshot.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

async function copySnapshotMedia(snapshot: Database.Database, destinationMediaDir: string): Promise<BackupMediaEntry[]> {
  const rows = snapshot.prepare('SELECT relative_path,size_bytes,sha256 FROM media ORDER BY relative_path').all() as Array<{ relative_path: string; size_bytes: number; sha256: string }>;
  const result: BackupMediaEntry[] = [];
  for (const row of rows) {
    const relativePath = safeMediaRelativePath(row.relative_path);
    const source = path.join(config.mediaDir, ...relativePath.split('/'));
    const destination = path.join(destinationMediaDir, ...relativePath.split('/'));
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Media отсутствует на диске: ${relativePath}`);
    if (stat.size !== Number(row.size_bytes)) throw new Error(`Размер media не совпадает с БД: ${relativePath}`);
    const sourceHash = await sha256File(source);
    if (sourceHash !== row.sha256) throw new Error(`SHA-256 media не совпадает с БД: ${relativePath}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    result.push({ relativePath, sizeBytes: stat.size, sha256: sourceHash });
  }
  return result;
}

async function createBackupBundleInternal(label: string): Promise<BackupListItem> {
  await fs.mkdir(config.backupDir, { recursive: true });
  const operationId = crypto.randomUUID();
  const staging = path.join(config.backupDir, `.bundle-stage-${operationId}`);
  const archiveName = `publikator-${timestampForFile()}-${sanitizeLabel(label)}.tgz`;
  const archivePath = path.join(config.backupDir, archiveName);
  await fs.mkdir(path.join(staging, 'media'), { recursive: true });

  try {
    const databasePath = path.join(staging, 'publikator.sqlite');
    await db.backup(databasePath);
    const snapshot = new Database(databasePath, { readonly: true, fileMustExist: true });
    let manifest: BackupManifest;
    try {
      const integrity = String(snapshot.pragma('integrity_check', { simple: true }));
      if (integrity.toLowerCase() !== 'ok') throw new Error(`SQLite integrity_check перед backup: ${integrity}`);
      const mediaFiles = await copySnapshotMedia(snapshot, path.join(staging, 'media'));
      manifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        appVersion: await appVersion(),
        schemaVersion: Number(snapshot.pragma('user_version', { simple: true })),
        createdAt: new Date().toISOString(),
        label: sanitizeLabel(label),
        masterKeyFingerprint: masterKeyFingerprint(),
        databaseFile: 'publikator.sqlite',
        databaseSha256: await sha256File(databasePath),
        mediaDirectory: 'media',
        counts: {
          projects: snapshotCount(snapshot, 'projects'),
          posts: snapshotCount(snapshot, 'posts'),
          socialAccounts: snapshotCount(snapshot, 'social_accounts'),
          media: snapshotCount(snapshot, 'media')
        },
        mediaFiles
      };
    } finally {
      snapshot.close();
    }

    await fs.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await validateBackupDirectory(staging);
    await tar.create({ file: archivePath, cwd: staging, gzip: true, portable: true }, ['manifest.json', 'publikator.sqlite', 'media']);
    const stat = await fs.stat(archivePath);
    return { name: archiveName, sizeBytes: stat.size, createdAt: manifest.createdAt };
  } catch (error) {
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

function claimBundleOperation(): () => void {
  if (bundleOperationInProgress) throw new Error('Уже выполняется операция с backup bundle');
  bundleOperationInProgress = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bundleOperationInProgress = false;
  };
}

export async function createBackupBundle(label = 'manual'): Promise<BackupListItem> {
  const releaseOperation = claimBundleOperation();
  let releaseMaintenance: (() => void) | null = null;
  try {
    releaseMaintenance = beginMaintenance('создание backup');
    return await createBackupBundleInternal(label);
  } finally {
    releaseMaintenance?.();
    releaseOperation();
  }
}

export async function listBackupBundles(): Promise<BackupListItem[]> {
  await fs.mkdir(config.backupDir, { recursive: true });
  const names = (await fs.readdir(config.backupDir)).filter((name) => /^publikator-.*\.tgz$/.test(name));
  const rows = await Promise.all(names.map(async (name) => {
    const stat = await fs.stat(path.join(config.backupDir, name));
    return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
  }));
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function resolveBackupBundle(name: string): string {
  if (!/^publikator-[a-zA-Z0-9_.-]+\.tgz$/.test(name) || path.basename(name) !== name) throw new Error('Некорректное имя backup bundle');
  return path.join(config.backupDir, name);
}

export async function stageRestoreBundle(archivePath: string): Promise<{ manifest: BackupManifest; preRestoreBackup: BackupListItem }> {
  const releaseOperation = claimBundleOperation();
  let releaseMaintenance: (() => void) | null = null;
  let staged = false;
  const extractionDir = path.join(config.backupDir, `.restore-stage-${crypto.randomUUID()}`);
  try {
    releaseMaintenance = beginMaintenance('подготовка восстановления backup');
    const pendingExists = await fs.stat(config.restorePendingDir).then(() => true).catch(() => false);
    if (pendingExists) throw new Error('Уже существует подготовленное восстановление. Перезапустите Publikator или удалите повреждённый pending restore вручную.');

    await extractBackupArchive(archivePath, extractionDir);
    const manifest = await validateBackupDirectory(extractionDir);
    const preRestoreBackup = await createBackupBundleInternal('pre-restore');
    await fs.rename(extractionDir, config.restorePendingDir);
    staged = true;
    return { manifest, preRestoreBackup };
  } finally {
    if (!staged) {
      await fs.rm(extractionDir, { recursive: true, force: true }).catch(() => undefined);
      releaseMaintenance?.();
      releaseOperation();
    }
    // При успешном staging maintenance и operation lock намеренно остаются активными
    // до SIGTERM: между подготовкой restore и остановкой процесса нельзя менять runtime state.
  }
}
