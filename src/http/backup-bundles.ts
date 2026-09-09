import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { event } from '../db.js';
import { createBackupBundle, listBackupBundles, resolveBackupBundle, stageRestoreBundle } from '../backups.js';

const MAX_BACKUP_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function scheduleRestart(app: FastifyInstance): void {
  app.log.warn('Validated restore staged; graceful process restart requested');
  const timer = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
  timer.unref();
}

function restoreConfirmed(request: FastifyRequest): boolean {
  const value = request.headers['x-publikator-restore'];
  return typeof value === 'string' && value === 'RESTORE';
}

async function stageAndReply(app: FastifyInstance, reply: FastifyReply, archivePath: string) {
  const staged = await stageRestoreBundle(archivePath);
  event({
    type: 'restore_staged',
    message: `Подготовлено восстановление backup от ${staged.manifest.createdAt}`,
    data: {
      backupCreatedAt: staged.manifest.createdAt,
      appVersion: staged.manifest.appVersion,
      schemaVersion: staged.manifest.schemaVersion,
      preRestoreBackup: staged.preRestoreBackup.name
    }
  });
  reply.send({
    ok: true,
    restart: true,
    manifest: staged.manifest,
    preRestoreBackup: staged.preRestoreBackup
  });
  scheduleRestart(app);
  return reply;
}

export async function registerBackupBundleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/backup-bundles', async () => listBackupBundles());

  app.post('/api/backup-bundles', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as { label?: unknown }
      : {};
    const label = typeof body.label === 'string' ? body.label : 'manual';
    try {
      const bundle = await createBackupBundle(label);
      event({ type: 'backup_bundle_created', message: `Создан полный backup bundle ${bundle.name}`, data: bundle });
      return reply.code(201).send(bundle);
    } catch (error) {
      app.log.error(error, 'backup bundle creation failed');
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/backup-bundles/:name/download', async (request, reply) => {
    const params = request.params as { name: string };
    let filePath: string;
    try {
      filePath = resolveBackupBundle(params.name);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) return reply.code(404).send({ error: 'Backup bundle не найден' });
    reply.header('content-type', 'application/gzip');
    reply.header('content-length', String(stat.size));
    reply.header('content-disposition', `attachment; filename="${params.name}"`);
    return reply.send(fs.createReadStream(filePath));
  });

  app.post('/api/backup-bundles/restore-upload', async (request, reply) => {
    if (!restoreConfirmed(request)) return reply.code(400).send({ error: 'Для восстановления требуется явное подтверждение RESTORE' });
    const part = await request.file({ limits: { files: 1, fileSize: MAX_BACKUP_UPLOAD_BYTES } });
    if (!part) return reply.code(400).send({ error: 'Backup bundle не передан' });
    const originalName = path.basename(part.filename || 'backup.tgz');
    if (!/\.(tgz|tar\.gz)$/i.test(originalName)) return reply.code(400).send({ error: 'Ожидается файл .tgz или .tar.gz' });

    await fsp.mkdir(config.backupDir, { recursive: true });
    const incomingPath = path.join(config.backupDir, `.restore-upload-${crypto.randomUUID()}.tgz`);
    try {
      await pipeline(part.file, fs.createWriteStream(incomingPath, { flags: 'wx', mode: 0o600 }));
      if (part.file.truncated) return reply.code(413).send({ error: 'Backup bundle превышает лимит 2 ГБ' });
      const stat = await fsp.stat(incomingPath);
      if (stat.size < 1) return reply.code(400).send({ error: 'Backup bundle пустой' });
      return await stageAndReply(app, reply, incomingPath);
    } catch (error) {
      app.log.error(error, 'uploaded restore failed');
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      await fsp.rm(incomingPath, { force: true }).catch(() => undefined);
    }
  });

  app.post('/api/backup-bundles/:name/restore', async (request, reply) => {
    if (!restoreConfirmed(request)) return reply.code(400).send({ error: 'Для восстановления требуется явное подтверждение RESTORE' });
    const params = request.params as { name: string };
    let filePath: string;
    try {
      filePath = resolveBackupBundle(params.name);
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) throw new Error('Backup bundle не найден');
      return await stageAndReply(app, reply, filePath);
    } catch (error) {
      app.log.error(error, 'restore from stored backup failed');
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
