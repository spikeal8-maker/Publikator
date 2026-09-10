import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { db, type Platform } from './db.js';
import { maintenanceState } from './runtime-gate.js';
import { schedulerStatus } from './scheduler.js';

export type DiagnosticSeverity = 'ok' | 'warning' | 'error';

export type DiagnosticsSnapshot = {
  severity: DiagnosticSeverity;
  generatedAt: string;
  app: {
    version: string;
    node: string;
    uptimeSeconds: number;
  };
  database: {
    path: string;
    schemaVersion: number;
    journalMode: string;
    quickCheck: string;
    sizeBytes: number;
    walSizeBytes: number;
    counts: Record<string, number>;
  };
  scheduler: ReturnType<typeof schedulerStatus> & { intervalMs: number };
  media: {
    directory: string;
    databaseFiles: number;
    databaseBytes: number;
    diskFiles: number;
    diskBytes: number;
    missingFiles: number;
    orphanFiles: number;
    sizeMismatches: number;
    symlinksIgnored: number;
    missingSample: string[];
    orphanSample: string[];
    sizeMismatchSample: string[];
  };
  storage: {
    dataDirectory: string;
    totalBytes: number | null;
    freeBytes: number | null;
    availableBytes: number | null;
  };
  publicMedia: {
    publicBaseUrl: string | null;
    configured: boolean;
    validUrl: boolean;
    https: boolean;
    requiredByEnabledPlatforms: Platform[];
    ready: boolean;
  };
  accounts: {
    total: number;
    enabled: number;
    byPlatform: Array<{ platform: Platform; total: number; enabled: number }>;
  };
  recovery: {
    pendingTargets: number;
  };
  maintenance: ReturnType<typeof maintenanceState>;
  backups: {
    bundleCount: number;
    legacySqliteCount: number;
    latestBundle: string | null;
  };
  warnings: string[];
  errors: string[];
};

type DiskFile = { relativePath: string; sizeBytes: number };

async function appVersion(): Promise<string> {
  try {
    const raw = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' && raw.version.trim() ? raw.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function statSize(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isFile() ? stat.size : 0;
}

async function walkMediaDirectory(root: string): Promise<{ files: DiskFile[]; symlinksIgnored: number }> {
  const files: DiskFile[] = [];
  let symlinksIgnored = 0;

  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        symlinksIgnored += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (stat?.isFile()) files.push({ relativePath: relativePath.replace(/\\/g, '/'), sizeBytes: stat.size });
    }
  }

  await walk(root, '');
  return { files, symlinksIgnored };
}

async function storageStats(): Promise<{ totalBytes: number | null; freeBytes: number | null; availableBytes: number | null }> {
  try {
    const stat = await fs.statfs(config.dataDir);
    const blockSize = Number(stat.bsize);
    return {
      totalBytes: blockSize * Number(stat.blocks),
      freeBytes: blockSize * Number(stat.bfree),
      availableBytes: blockSize * Number(stat.bavail)
    };
  } catch {
    return { totalBytes: null, freeBytes: null, availableBytes: null };
  }
}

function publicBaseStatus(enabledPlatforms: Platform[]): DiagnosticsSnapshot['publicMedia'] {
  const raw = config.publicBaseUrl;
  let validUrl = false;
  let https = false;
  if (raw) {
    try {
      const parsed = new URL(raw);
      validUrl = ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname);
      https = parsed.protocol === 'https:';
    } catch {
      validUrl = false;
    }
  }
  const requiredByEnabledPlatforms = [...new Set(enabledPlatforms.filter((platform) => platform === 'max' || platform === 'instagram'))];
  return {
    publicBaseUrl: raw || null,
    configured: Boolean(raw),
    validUrl,
    https,
    requiredByEnabledPlatforms,
    ready: requiredByEnabledPlatforms.length === 0 || (validUrl && https)
  };
}

export async function collectDiagnostics(): Promise<DiagnosticsSnapshot> {
  const warnings: string[] = [];
  const errors: string[] = [];

  const quickRows = db.pragma('quick_check') as Array<Record<string, unknown>>;
  const quickCheck = quickRows.length === 1 ? String(Object.values(quickRows[0] ?? {})[0] ?? '') : JSON.stringify(quickRows);
  if (quickCheck.toLowerCase() !== 'ok') errors.push(`SQLite quick_check: ${quickCheck}`);

  const schemaVersion = Number(db.pragma('user_version', { simple: true }) ?? 0);
  const journalMode = String(db.pragma('journal_mode', { simple: true }) ?? 'unknown');
  if (journalMode.toLowerCase() !== 'wal') warnings.push(`SQLite journal_mode=${journalMode}, ожидался WAL`);

  const countQueries: Record<string, string> = {
    projects: 'SELECT COUNT(*) AS count FROM projects',
    posts: 'SELECT COUNT(*) AS count FROM posts',
    socialAccounts: 'SELECT COUNT(*) AS count FROM social_accounts',
    postTargets: 'SELECT COUNT(*) AS count FROM post_targets',
    media: 'SELECT COUNT(*) AS count FROM media',
    scheduleSlots: 'SELECT COUNT(*) AS count FROM schedule_slots',
    publicationEvents: 'SELECT COUNT(*) AS count FROM publication_events'
  };
  const counts: Record<string, number> = {};
  for (const [key, sql] of Object.entries(countQueries)) {
    counts[key] = Number((db.prepare(sql).get() as { count: number }).count);
  }

  const mediaRows = db.prepare('SELECT relative_path,size_bytes FROM media ORDER BY relative_path').all() as Array<{ relative_path: string; size_bytes: number }>;
  const dbMedia = new Map(mediaRows.map((row) => [String(row.relative_path).replace(/\\/g, '/'), Number(row.size_bytes)]));
  const diskMedia = await walkMediaDirectory(config.mediaDir);
  const diskMap = new Map(diskMedia.files.map((file) => [file.relativePath, file.sizeBytes]));
  const missing = [...dbMedia.keys()].filter((relativePath) => !diskMap.has(relativePath));
  const orphan = [...diskMap.keys()].filter((relativePath) => !dbMedia.has(relativePath));
  const sizeMismatch = [...dbMedia.entries()]
    .filter(([relativePath, size]) => diskMap.has(relativePath) && diskMap.get(relativePath) !== size)
    .map(([relativePath]) => relativePath);
  if (missing.length) errors.push(`Media отсутствуют на диске: ${missing.length}`);
  if (sizeMismatch.length) errors.push(`Размер media не совпадает с SQLite: ${sizeMismatch.length}`);
  if (orphan.length) warnings.push(`Найдены незарегистрированные media-файлы: ${orphan.length}`);
  if (diskMedia.symlinksIgnored) warnings.push(`В media storage проигнорировано symlink: ${diskMedia.symlinksIgnored}`);

  const accountRows = db.prepare('SELECT platform,enabled,COUNT(*) AS count FROM social_accounts GROUP BY platform,enabled ORDER BY platform,enabled').all() as Array<{ platform: Platform; enabled: number; count: number }>;
  const byPlatformMap = new Map<Platform, { platform: Platform; total: number; enabled: number }>();
  for (const row of accountRows) {
    const current = byPlatformMap.get(row.platform) ?? { platform: row.platform, total: 0, enabled: 0 };
    current.total += Number(row.count);
    if (row.enabled) current.enabled += Number(row.count);
    byPlatformMap.set(row.platform, current);
  }
  const byPlatform = [...byPlatformMap.values()];
  const enabledPlatforms = byPlatform.filter((row) => row.enabled > 0).map((row) => row.platform);
  const publicMedia = publicBaseStatus(enabledPlatforms);
  if (!publicMedia.ready) {
    errors.push(`Для активных ${publicMedia.requiredByEnabledPlatforms.join(', ')} требуется корректный PUBLIC_BASE_URL с HTTPS`);
  } else if (!publicMedia.configured) {
    warnings.push('PUBLIC_BASE_URL не задан; Telegram/VK могут работать, но публичные media URL недоступны');
  } else if (!publicMedia.https) {
    warnings.push('PUBLIC_BASE_URL использует HTTP; для MAX/Instagram потребуется HTTPS');
  }

  const recovery = Number((db.prepare("SELECT COUNT(*) AS count FROM post_targets WHERE state='RECOVERY_NEEDED'").get() as { count: number }).count);
  if (recovery > 0) warnings.push(`Требуют ручного решения RECOVERY_NEEDED: ${recovery}`);

  const backupNames = await fs.readdir(config.backupDir).catch(() => [] as string[]);
  const bundles = backupNames.filter((name) => name.endsWith('.tgz')).sort().reverse();
  const legacySqlite = backupNames.filter((name) => name.endsWith('.sqlite'));
  if (bundles.length === 0) warnings.push('Полных backup bundles пока нет');

  const storage = await storageStats();
  if (storage.availableBytes !== null && storage.totalBytes !== null && storage.totalBytes > 0) {
    const availableRatio = storage.availableBytes / storage.totalBytes;
    if (availableRatio < 0.05) errors.push('На файловой системе data доступно меньше 5% места');
    else if (availableRatio < 0.15) warnings.push('На файловой системе data доступно меньше 15% места');
  }

  const scheduler = schedulerStatus();
  if (scheduler.lastError) warnings.push(`Последняя ошибка scheduler: ${scheduler.lastError}`);

  return {
    severity: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'ok',
    generatedAt: new Date().toISOString(),
    app: {
      version: await appVersion(),
      node: process.version,
      uptimeSeconds: Math.floor(process.uptime())
    },
    database: {
      path: config.dbPath,
      schemaVersion,
      journalMode,
      quickCheck,
      sizeBytes: await statSize(config.dbPath),
      walSizeBytes: await statSize(`${config.dbPath}-wal`),
      counts
    },
    scheduler: { ...scheduler, intervalMs: config.schedulerIntervalMs },
    media: {
      directory: config.mediaDir,
      databaseFiles: dbMedia.size,
      databaseBytes: [...dbMedia.values()].reduce((sum, size) => sum + size, 0),
      diskFiles: diskMap.size,
      diskBytes: [...diskMap.values()].reduce((sum, size) => sum + size, 0),
      missingFiles: missing.length,
      orphanFiles: orphan.length,
      sizeMismatches: sizeMismatch.length,
      symlinksIgnored: diskMedia.symlinksIgnored,
      missingSample: missing.slice(0, 10),
      orphanSample: orphan.slice(0, 10),
      sizeMismatchSample: sizeMismatch.slice(0, 10)
    },
    storage: {
      dataDirectory: config.dataDir,
      ...storage
    },
    publicMedia,
    accounts: {
      total: byPlatform.reduce((sum, row) => sum + row.total, 0),
      enabled: byPlatform.reduce((sum, row) => sum + row.enabled, 0),
      byPlatform
    },
    recovery: { pendingTargets: recovery },
    maintenance: maintenanceState(),
    backups: {
      bundleCount: bundles.length,
      legacySqliteCount: legacySqlite.length,
      latestBundle: bundles[0] ?? null
    },
    warnings,
    errors
  };
}
