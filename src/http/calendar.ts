import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';

type CalendarRow = {
  id: string;
  title: string;
  body: string;
  status: string;
  editorial_stage: string;
  schedule_mode: string;
  scheduled_at_utc: string;
  schedule_timezone: string | null;
  publication_kind: string;
  content_format: string;
  source_type: string | null;
  source_ref: string | null;
  project_name: string;
  thumbnail_path: string | null;
  platforms_csv: string | null;
};

function parseRangeValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} обязателен`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} должен быть ISO date-time`);
  return date.toISOString();
}

function calendarRows(from: string, to: string): CalendarRow[] {
  return db.prepare(`SELECT
      p.id,p.title,p.body,p.status,p.editorial_stage,p.schedule_mode,
      p.scheduled_at_utc,p.schedule_timezone,p.publication_kind,p.content_format,
      p.source_type,p.source_ref,pr.name AS project_name,
      (SELECT m.relative_path FROM media m WHERE m.post_id=p.id
        ORDER BY m.sort_order,m.created_at,m.id LIMIT 1) AS thumbnail_path,
      (SELECT GROUP_CONCAT(DISTINCT a.platform)
        FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
        WHERE pt.post_id=p.id AND pt.enabled=1) AS platforms_csv
    FROM posts p JOIN projects pr ON pr.id=p.project_id
    WHERE p.editorial_stage NOT IN ('ARCHIVED','TRASHED')
      AND p.scheduled_at_utc IS NOT NULL
      AND p.scheduled_at_utc >= ? AND p.scheduled_at_utc < ?
    ORDER BY p.scheduled_at_utc,p.created_at,p.id
    LIMIT 5000`).all(from, to) as CalendarRow[];
}

export async function registerCalendarRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/calendar', async (request, reply) => {
    try {
      const query = request.query as { from?: unknown; to?: unknown };
      const from = parseRangeValue(query.from, 'from');
      const to = parseRangeValue(query.to, 'to');
      const fromMs = new Date(from).getTime();
      const toMs = new Date(to).getTime();
      if (toMs <= fromMs) return reply.code(400).send({ error: 'to должен быть позже from' });
      if (toMs - fromMs > 1000 * 60 * 60 * 24 * 93) {
        return reply.code(400).send({ error: 'Диапазон календаря не может превышать 93 дня' });
      }
      const items = calendarRows(from, to).map((row) => ({
        ...row,
        platforms: row.platforms_csv ? row.platforms_csv.split(',').filter(Boolean) : []
      }));
      return { from, to, count: items.length, items };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
