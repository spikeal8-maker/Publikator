import { config } from './config.js';
import { applyPendingRestore } from './restore-bootstrap.js';

const restoreResult = await applyPendingRestore();

const { migrate } = await import('./db.js');
const { cleanupVideoTemp } = await import('./video-media.js');
const { buildApp } = await import('./app.js');
const { schedulerTick } = await import('./scheduler.js');
const { googleSheetsPollingTick } = await import('./google-sheets-polling.js');

migrate();
await cleanupVideoTemp();
const app = await buildApp();

const interval = setInterval(() => {
  schedulerTick().catch((error) => app.log.error(error, 'scheduler tick failed'));
}, config.schedulerIntervalMs);
interval.unref();

const sourcePollingInterval = setInterval(() => {
  googleSheetsPollingTick().catch((error) => app.log.error(error, 'Google Sheets polling tick failed'));
}, 60_000);
sourcePollingInterval.unref();

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  clearInterval(interval);
  clearInterval(sourcePollingInterval);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ port: config.port, host: config.host });
app.log.info({ publicBaseUrl: config.publicBaseUrl || null, restoreApplied: restoreResult.applied, restoredBackupCreatedAt: restoreResult.createdAt || null }, 'Publikator started');
