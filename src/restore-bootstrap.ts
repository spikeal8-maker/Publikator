import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { validateBackupDirectory } from './backup-format.js';

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true).catch(() => false);
}

async function moveIfExists(source: string, destination: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
  return true;
}

async function removeIfExists(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
}

export async function applyPendingRestore(): Promise<{ applied: boolean; createdAt?: string }> {
  if (!(await exists(config.restorePendingDir))) return { applied: false };

  const manifest = await validateBackupDirectory(config.restorePendingDir);
  const rollbackDir = path.join(config.dataDir, `.restore-rollback-${crypto.randomUUID()}`);
  const rollbackDb = path.join(rollbackDir, 'publikator.sqlite');
  const rollbackWal = path.join(rollbackDir, 'publikator.sqlite-wal');
  const rollbackShm = path.join(rollbackDir, 'publikator.sqlite-shm');
  const rollbackMedia = path.join(rollbackDir, 'media');
  const pendingDb = path.join(config.restorePendingDir, 'publikator.sqlite');
  const pendingMedia = path.join(config.restorePendingDir, 'media');
  const liveWal = `${config.dbPath}-wal`;
  const liveShm = `${config.dbPath}-shm`;

  await fs.mkdir(rollbackDir, { recursive: true });

  let oldDbMoved = false;
  let oldWalMoved = false;
  let oldShmMoved = false;
  let oldMediaMoved = false;
  let newDbInstalled = false;
  let newMediaInstalled = false;

  try {
    oldDbMoved = await moveIfExists(config.dbPath, rollbackDb);
    oldWalMoved = await moveIfExists(liveWal, rollbackWal);
    oldShmMoved = await moveIfExists(liveShm, rollbackShm);
    oldMediaMoved = await moveIfExists(config.mediaDir, rollbackMedia);

    await fs.rename(pendingDb, config.dbPath);
    newDbInstalled = true;

    if (await exists(pendingMedia)) {
      await fs.rename(pendingMedia, config.mediaDir);
      newMediaInstalled = true;
    } else {
      await fs.mkdir(config.mediaDir, { recursive: true });
      newMediaInstalled = true;
    }

    await removeIfExists(config.restorePendingDir);
    await removeIfExists(rollbackDir);
    return { applied: true, createdAt: manifest.createdAt };
  } catch (error) {
    if (newMediaInstalled) await removeIfExists(config.mediaDir);
    if (newDbInstalled) await removeIfExists(config.dbPath);
    await removeIfExists(liveWal);
    await removeIfExists(liveShm);

    const rollbackErrors: string[] = [];
    try { if (oldDbMoved) await fs.rename(rollbackDb, config.dbPath); } catch (rollbackError) { rollbackErrors.push(`db: ${String(rollbackError)}`); }
    try { if (oldWalMoved) await fs.rename(rollbackWal, liveWal); } catch (rollbackError) { rollbackErrors.push(`wal: ${String(rollbackError)}`); }
    try { if (oldShmMoved) await fs.rename(rollbackShm, liveShm); } catch (rollbackError) { rollbackErrors.push(`shm: ${String(rollbackError)}`); }
    try { if (oldMediaMoved) await fs.rename(rollbackMedia, config.mediaDir); } catch (rollbackError) { rollbackErrors.push(`media: ${String(rollbackError)}`); }

    if (rollbackErrors.length === 0) {
      await removeIfExists(config.restorePendingDir);
      await removeIfExists(rollbackDir);
    }
    const message = error instanceof Error ? error.message : String(error);
    const rollbackSuffix = rollbackErrors.length
      ? ` Rollback errors: ${rollbackErrors.join('; ')}`
      : ' Текущие данные восстановлены из локального rollback; повреждённый pending restore удалён.';
    throw new Error(`Не удалось применить pending restore: ${message}.${rollbackSuffix}`);
  }
}
