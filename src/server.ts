import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { applyPendingRestore } from './restore-bootstrap.js';

const restoreResult = await applyPendingRestore();

const { migrate } = await import('./db.js');
const { registerMaintenanceGuard } = await import('./http/maintenance.js');
const { registerRoutes } = await import('./http/routes.js');
const { registerTargetOverrideRoutes } = await import('./http/target-overrides.js');
const { registerMediaOrderRoutes } = await import('./http/media-order.js');
const { registerBackupBundleRoutes } = await import('./http/backup-bundles.js');
const { registerContentPlanRoutes } = await import('./http/content-plan.js');
const { schedulerTick } = await import('./scheduler.js');

migrate();

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
await app.register(cookie);
await app.register(multipart);
await app.register(fastifyStatic, { root: config.publicDir, prefix: '/' });
await app.register(fastifyStatic, { root: config.mediaDir, prefix: '/public-media/', decorateReply: false, index: false });
await registerMaintenanceGuard(app);
await registerRoutes(app);
await registerTargetOverrideRoutes(app);
await registerMediaOrderRoutes(app);
await registerBackupBundleRoutes(app);
await registerContentPlanRoutes(app);

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/') || request.url.startsWith('/public-media/')) return reply.code(404).send({ error: 'Not found' });
  return reply.type('text/html').send(fs.createReadStream(`${config.publicDir}/index.html`));
});

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
