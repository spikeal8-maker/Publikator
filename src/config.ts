import path from 'node:path';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is missing`);
  return value;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function boundedNonNegativeInteger(name: string, fallback: number, max: number): number {
  const value = nonNegativeInteger(name, fallback);
  if (value > max) throw new Error(`${name} must be between 0 and ${max}`);
  return value;
}

function optionalCommitSha(name: string): string {
  const value = process.env[name]?.trim().toLowerCase() || '';
  if (value && !/^[a-f0-9]{40}$/.test(value)) throw new Error(`${name} must be a 40-character Git commit SHA`);
  return value;
}

function releaseVersion(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) throw new Error(`${name} must be a semantic version`);
  return value;
}

function trustedProxyList(name: string): false | string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return false;
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return false;
  if (values.some((value) => value === '*' || value.toLowerCase() === 'true')) {
    throw new Error(`${name} must list trusted proxy IP/CIDR names explicitly; wildcard trust is forbidden`);
  }
  return values;
}

const dataDir = process.env.DATA_DIR?.trim() || path.resolve('data');
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '') || '';
const masterKey = required('APP_MASTER_KEY');
if (masterKey.length < 32) throw new Error('APP_MASTER_KEY must be at least 32 characters long');

export const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  dbPath: path.join(dataDir, 'publikator.sqlite'),
  mediaDir: path.join(dataDir, 'media'),
  backupDir: path.join(dataDir, 'backups'),
  restorePendingDir: path.join(dataDir, '.restore-pending'),
  publicDir: path.resolve('public'),
  publicBaseUrl,
  trustProxy: trustedProxyList('TRUST_PROXY'),
  adminPassword: required('ADMIN_PASSWORD'),
  masterKey,
  sessionTtlMs: Number(process.env.SESSION_TTL_HOURS || 24) * 60 * 60 * 1000,
  schedulerIntervalMs: Math.max(5000, Number(process.env.SCHEDULER_INTERVAL_MS || 15000)),
  queueSlotGraceMinutes: boundedNonNegativeInteger('QUEUE_SLOT_GRACE_MINUTES', 60, 1440),
  eventRetentionDays: nonNegativeInteger('EVENT_RETENTION_DAYS', 180),
  backupRetentionCount: nonNegativeInteger('BACKUP_RETENTION_COUNT', 30),
  appBuildSha: optionalCommitSha('APP_BUILD_SHA'),
  releaseTargetVersion: releaseVersion('RELEASE_TARGET_VERSION', '1.0.0')
};
