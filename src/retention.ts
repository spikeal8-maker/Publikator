import fs from 'node:fs/promises';
import { config } from './config.js';
import { db, event, nowIso } from './db.js';
import { listBackupBundles, resolveBackupBundle } from './backups.js';
import { beginMaintenance } from './runtime-gate.js';

const RETRY_AFTER_MS = 5 * 60 * 1000;
let lastSuccessfulDay: string | null = null;
let lastRunAt: string | null = null;
let lastError: string | null = null;
let nextRetryAt = 0;
let lastDeletedEvents = 0;
let lastDeletedBackups: string[] = [];

export type RetentionStatus = {
  eventRetentionDays: number;
  backupRetentionCount: number;
  lastSuccessfulDay: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  lastDeletedEvents: number;
  lastDeletedBackups: string[];
};

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function retentionStatus(): RetentionStatus {
  return {
    eventRetentionDays: config.eventRetentionDays,
    backupRetentionCount: config.backupRetentionCount,
    lastSuccessfulDay,
    lastRunAt,
    lastError,
    lastDeletedEvents,
    lastDeletedBackups: [...lastDeletedBackups]
  };
}

function pruneEvents(): number {
  if (config.eventRetentionDays === 0) return 0;
  const cutoff = new Date(Date.now() - config.eventRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`DELETE FROM publication_events
    WHERE created_at < ?
      AND (
        post_id IS NULL
        OR post_id NOT IN (
          SELECT DISTINCT post_id FROM post_targets WHERE state='RECOVERY_NEEDED'
        )
      )`).run(cutoff);
  return Number(result.changes);
}

async function pruneBackups(): Promise<string[]> {
  if (config.backupRetentionCount === 0) return [];
  const bundles = await listBackupBundles();
  if (bundles.length <= config.backupRetentionCount) return [];

  const keep = new Set(bundles.slice(0, config.backupRetentionCount).map((bundle) => bundle.name));
  const latestPreRestore = bundles.find((bundle) => bundle.name.includes('pre-restore'));
  if (latestPreRestore) keep.add(latestPreRestore.name);

  const deleted: string[] = [];
  for (const bundle of bundles) {
    if (keep.has(bundle.name)) continue;
    await fs.rm(resolveBackupBundle(bundle.name), { force: true });
    deleted.push(bundle.name);
  }
  return deleted;
}

export async function runRetentionIfDue(): Promise<void> {
  const today = utcDay();
  if (lastSuccessfulDay === today) return;
  if (Date.now() < nextRetryAt) return;

  let releaseMaintenance: (() => void) | null = null;
  try {
    releaseMaintenance = beginMaintenance('retention housekeeping');
    const deletedEvents = pruneEvents();
    const deletedBackups = await pruneBackups();
    lastSuccessfulDay = today;
    lastRunAt = nowIso();
    lastError = null;
    lastDeletedEvents = deletedEvents;
    lastDeletedBackups = deletedBackups;
    nextRetryAt = 0;

    if (deletedEvents > 0 || deletedBackups.length > 0) {
      event({
        type: 'retention_housekeeping',
        message: `Retention: удалено событий ${deletedEvents}, backup bundles ${deletedBackups.length}`,
        data: {
          eventRetentionDays: config.eventRetentionDays,
          backupRetentionCount: config.backupRetentionCount,
          deletedEvents,
          deletedBackups
        }
      });
    }
  } catch (error) {
    lastRunAt = nowIso();
    lastError = error instanceof Error ? error.message : String(error);
    nextRetryAt = Date.now() + RETRY_AFTER_MS;
  } finally {
    releaseMaintenance?.();
  }
}
