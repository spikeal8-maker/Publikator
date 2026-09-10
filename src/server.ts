import { config } from './config.js';
import { applyPendingRestore } from './restore-bootstrap.js';

const restoreResult = await applyPendingRestore();

const { migrate } = await import('./db.js');
const { buildApp } = await import('./app.js');
const { schedulerTick } = await import('./scheduler.js');

migrate();
const app = await buildApp();

const interval = setInterval(() => {
  schedulerTick().catch((error) => app.log.error(error, 'scheduler tick failed'));
}, config.schedulerIntervalMs);
interval.unref();

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  clearInterval(interval);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ port: config.port, host: config.host });
app.log.info({ publicBaseUrl: config.publicBaseUrl || null, restoreApplied: restoreResult.applied, restoredBackupCreatedAt: restoreResult.createdAt || null }, 'Publikator started');
