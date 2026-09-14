import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { registerBrowserSecurity } from './http/security.js';
import { registerMaintenanceGuard } from './http/maintenance.js';
import { registerLegacyBackupBlocker } from './http/legacy-backups.js';
import { registerRoutes } from './http/routes.js';
import { registerTargetOverrideRoutes } from './http/target-overrides.js';
import { registerMediaOrderRoutes } from './http/media-order.js';
import { registerBackupBundleRoutes } from './http/backup-bundles.js';
import { registerContentPlanRoutes } from './http/content-plan.js';
import { registerContentPlanV3Routes } from './http/content-plan-v3.js';
import { registerDiagnosticsRoutes } from './http/diagnostics.js';
import { registerReleaseGateRoutes } from './http/release-gate.js';
import { registerEditorialLifecycleRoutes } from './http/editorial-lifecycle.js';
import { registerCalendarRoutes } from './http/calendar.js';
import { registerContentLibraryRoutes } from './http/content-library.js';
import { registerPlatformCapabilityRoutes } from './http/platform-capabilities.js';
import { registerPlatformPreviewRoutes } from './http/platform-previews.js';
import { registerEditorialDashboardRoutes } from './http/editorial-dashboard.js';
import { registerVideoMediaRoutes } from './http/video-media.js';
import { registerPublicationUnitRoutes } from './http/publication-units.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: config.trustProxy
  });
  await registerBrowserSecurity(app);
  await app.register(cookie);
  await app.register(multipart);
  await app.register(fastifyStatic, { root: config.publicDir, prefix: '/' });
  await app.register(fastifyStatic, { root: config.mediaDir, prefix: '/public-media/', decorateReply: false, index: false });
  await registerMaintenanceGuard(app);
  await registerLegacyBackupBlocker(app);
  await registerRoutes(app);
  await registerVideoMediaRoutes(app);
  await registerEditorialLifecycleRoutes(app);
  await registerCalendarRoutes(app);
  await registerContentLibraryRoutes(app);
  await registerPlatformCapabilityRoutes(app);
  await registerPlatformPreviewRoutes(app);
  await registerEditorialDashboardRoutes(app);
  await registerTargetOverrideRoutes(app);
  await registerMediaOrderRoutes(app);
  await registerPublicationUnitRoutes(app);
  await registerBackupBundleRoutes(app);
  await registerContentPlanRoutes(app);
  await registerContentPlanV3Routes(app);
  await registerDiagnosticsRoutes(app);
  await registerReleaseGateRoutes(app);

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/public-media/')) return reply.code(404).send({ error: 'Not found' });
    return reply.type('text/html').send(fs.createReadStream(`${config.publicDir}/index.html`));
  });

  return app;
}
