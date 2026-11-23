import { config } from './config.js';
import { db, nowIso } from './db.js';
import { z } from 'zod';

export function collectOwnerConsoleStatus(ownerId: string) {
  const recentRuns = db.prepare(`SELECT status,COUNT(*) AS count FROM owner_ai_runs
    WHERE owner_id=? AND updated_at>=? GROUP BY status ORDER BY status`)
    .all(ownerId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const publicationQueue = db.prepare(`SELECT status,COUNT(*) AS count FROM posts
    WHERE status IN ('READY','PUBLISHING','FAILED','PARTIAL') GROUP BY status ORDER BY status`).all();
  return {
    service: 'publikator',
    buildSha: config.appBuildSha || null,
    schemaVersion: Number(db.pragma('user_version', { simple: true })),
    uptimeSeconds: Math.floor(process.uptime()),
    recentRuns,
    publicationQueue,
    checkedAt: nowIso(),
  };
}

export const changeDraftSchema = z.object({
  title: z.string().trim().min(1).max(140),
  observed: z.string().trim().min(1).max(2000),
  expected: z.string().trim().min(1).max(2000),
  acceptance: z.string().trim().min(1).max(2000),
}).strict();

export function prepareOwnerChangeDraft(input: z.infer<typeof changeDraftSchema>) {
  return {
    title: input.title,
    body: [
      '## Текущее поведение', input.observed,
      '## Ожидаемое поведение', input.expected,
      '## Проверка результата', input.acceptance,
    ].join('\n\n'),
    repositoryUrl: 'https://github.com/spikeal8-maker/Publikator/issues/new',
  };
}
