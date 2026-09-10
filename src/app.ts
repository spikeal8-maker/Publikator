import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { registerMaintenanceGuard } from './http/maintenance.js';
import { registerLegacyBackupBlocker } from './http/legacy-backups.js';
import { registerRoutes } from './http/routes.js';
import { registerTargetOverrideRoutes } from './http/target-overrides.js';
import { registerMediaOrderRoutes } from './http/media-order.js';
import { registerBackupBundleRoutes } from './http/backup-bundles.js';
import { registerContentPlanRoutes } from './http/content-plan.js';
import { registerDiagnosticsRoutes } from './http/diagnostics.js';
import { registerReleaseGateRoutes } from './http/release-gate.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart);
  await app.register(fastifyStatic, { root: config.publicDir, prefix: '/' });
  await app.register(fastifyStatic, { root: config.mediaDir, prefix: '/public-media/', decorateReply: false, index: false });
  await registerMaintenanceGuard(app);
  await registerLegacyBackupBlocker(app);
  await registerRoutes(app);
  await registerTargetOverrideRoutes(app);
  await registerMediaOrderRoutes(app);
  await registerBackupBundleRoutes(app);
  await registerContentPlanRoutes(app);
  await registerDiagnosticsRoutes(app);
  await registerReleaseGateRoutes(app);

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/public-media/')) return reply.code(404).send({ error: 'Not found' });
    return reply.type('text/html').send(fs.createReadStream(`${config.publicDir}/index.html`));
  });

  return app;
}
