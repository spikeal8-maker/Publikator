import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db.js';
import {
  CONTENT_PLAN_COLUMNS,
  CONTENT_PLAN_VERSION,
  MAX_CONTENT_PLAN_BYTES,
  applyValidatedContentPlan,
  createContentPlanXlsx,
  exportContentPlanRows,
  parseContentPlanFile,
  serializeContentPlanCsv,
  validateContentPlan
} from '../content-plan.js';
import { beginExclusiveRuntimeMaintenance } from '../runtime-gate.js';

function exportFileStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function projectFilter(request: FastifyRequest): { projectId?: string; suffix: string } {
  const query = request.query as { projectId?: string };
  const projectId = typeof query.projectId === 'string' && query.projectId.trim() ? query.projectId.trim() : undefined;
  if (!projectId) return { suffix: 'all' };
  const project = db.prepare('SELECT id,slug FROM projects WHERE id=?').get(projectId) as { id: string; slug: string } | undefined;
  if (!project) throw new Error('Проект для экспорта не найден');
  return { projectId: project.id, suffix: project.slug };
}

async function uploadedContentPlan(request: FastifyRequest): Promise<{ filename: string; buffer: Buffer }> {
  const part = await request.file({ limits: { files: 1, fileSize: MAX_CONTENT_PLAN_BYTES } });
  if (!part) throw new Error('Файл контент-плана не передан');
  const filename = path.basename(part.filename || 'content-plan.csv');
  const buffer = await part.toBuffer();
  if (part.file.truncated) throw new Error('Файл контент-плана больше 20 МБ');
  if (!/\.(csv|xlsx)$/i.test(filename)) throw new Error('Поддерживаются только .csv и .xlsx');
  return { filename, buffer };
}

export async function registerContentPlanRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/content-plan/schema', async () => ({
    version: CONTENT_PLAN_VERSION,
    columns: CONTENT_PLAN_COLUMNS,
    semantics: {
      project: 'slug существующего проекта',
      schedule_mode: ['MANUAL', 'AT', 'QUEUE'],
      targets: 'JSON array: [{platform,name,accountId?}]',
      platform_overrides: 'JSON array: [{platform,name,accountId?,text}]',
      media_references: 'JSON array: [{relativePath,originalName?,sha256?}]',
      importedStatus: 'DRAFT'
    },
    examples: {
      targets: [{ platform: 'telegram', name: 'Основной канал', accountId: 'acc_...' }],
      platform_overrides: [{ platform: 'vk', name: 'Школа', text: 'Отдельный текст для VK' }],
      media_references: [{ relativePath: 'post_.../med_....jpg', sha256: '64-hex' }]
    }
  }));

  app.get('/api/content-plan/export.csv', async (request, reply) => {
    try {
      const filter = projectFilter(request);
      const rows = exportContentPlanRows(filter.projectId);
      const csv = serializeContentPlanCsv(rows);
      const filename = `publikator-content-plan-${filter.suffix}-${exportFileStamp()}.csv`;
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${filename}"`);
      return reply.send(Buffer.from(csv, 'utf8'));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/content-plan/export.xlsx', async (request, reply) => {
    try {
      const filter = projectFilter(request);
      const rows = exportContentPlanRows(filter.projectId);
      const workbook = await createContentPlanXlsx(rows);
      const filename = `publikator-content-plan-${filter.suffix}-${exportFileStamp()}.xlsx`;
      reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('content-length', String(workbook.byteLength));
      reply.header('content-disposition', `attachment; filename="${filename}"`);
      return reply.send(workbook);
    } catch (error) {
      app.log.error(error, 'content plan xlsx export failed');
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/content-plan/import/preview', async (request, reply) => {
    try {
      const uploaded = await uploadedContentPlan(request);
      const parsed = await parseContentPlanFile(uploaded.filename, uploaded.buffer);
      return await validateContentPlan(parsed);
    } catch (error) {
      app.log.warn(error, 'content plan preview rejected');
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/content-plan/import/apply', async (request, reply) => {
    const confirmation = request.headers['x-publikator-content-plan'];
    if (confirmation !== 'IMPORT') return reply.code(400).send({ error: 'Для импорта требуется явное подтверждение IMPORT' });
    const expectedSha = request.headers['x-content-plan-sha256'];
    if (typeof expectedSha !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha)) {
      return reply.code(400).send({ error: 'Сначала выполните dry-run preview и передайте его SHA-256' });
    }

    let releaseMaintenance: (() => void) | null = null;
    try {
      const uploaded = await uploadedContentPlan(request);
      const parsed = await parseContentPlanFile(uploaded.filename, uploaded.buffer);
      if (parsed.fileSha256 !== expectedSha.toLowerCase()) {
        return reply.code(409).send({ error: 'Файл изменился после preview. Выполните dry-run ещё раз.' });
      }

      releaseMaintenance = beginExclusiveRuntimeMaintenance('импорт контент-плана');
      const validation = await validateContentPlan(parsed);
      if (!validation.canApply) return reply.code(409).send({ error: 'Контент-план содержит ошибки', validation });
      const result = await applyValidatedContentPlan(validation);
      return { ok: true, fileSha256: parsed.fileSha256, createdCount: result.createdCount, postIds: result.postIds };
    } catch (error) {
      app.log.error(error, 'content plan import failed');
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseMaintenance?.();
    }
  });
}
