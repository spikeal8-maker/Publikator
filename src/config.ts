import path from 'node:path';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is missing`);
  return value;
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
  adminPassword: required('ADMIN_PASSWORD'),
  masterKey,
  sessionTtlMs: Number(process.env.SESSION_TTL_HOURS || 24) * 60 * 60 * 1000,
  schedulerIntervalMs: Math.max(5000, Number(process.env.SCHEDULER_INTERVAL_MS || 15000))
};
