import type { FastifyInstance } from 'fastify';

const LEGACY_BACKUP_PATH = '/api/backups';

export async function registerLegacyBackupBlocker(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    const pathname = request.url.split('?', 1)[0];
    if (pathname !== LEGACY_BACKUP_PATH) return;
    return reply.code(410).send({
      error: 'Одиночные SQLite-backup отключены. Используйте /api/backup-bundles: полный .tgz содержит SQLite, media и manifest.'
    });
  });
}
