import type { FastifyInstance } from 'fastify';
import { listPlatformCapabilities } from '../platforms/capabilities.js';

export async function registerPlatformCapabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/platform-capabilities', async () => ({
    version: 1,
    capabilities: listPlatformCapabilities()
  }));
}
