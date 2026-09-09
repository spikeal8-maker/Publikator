import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { migrate } from './db.js';
import { registerRoutes } from './http/routes.js';
import { registerContentPlanRoutes } from './http/content-plan-routes.js';
import { schedulerTick } from './scheduler.js';

migrate();

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
await app.register(cookie);
await app.register(multipart);
await app.register(fastifyStatic, { root: config.publicDir, prefix: '/' });
await app.register(fastifyStatic, { root: config.mediaDir, prefix: '/public-media/', decorateReply: false, index: false });
await registerRoutes(app);
await registerContentPlanRoutes(app);

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/') || request.url.startsWith('/public-media/')) return reply.code(404).send({ error: 'Not found' });
  return reply.type('text/html').send(fs.createReadStream(`${config.publicDir}/index.html`));
});

const interval = setInterval(() => {
  schedulerTick().catch((error) => app.log.error(error, 'scheduler tick failed'));
}, config.schedulerIntervalMs);
interval.unref();

const close = async () => {
  clearInterval(interval);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ port: config.port, host: config.host });
app.log.info({ publicBaseUrl: config.publicBaseUrl || null, metaGraphVersion: config.metaGraphVersion }, 'Publikator started');
