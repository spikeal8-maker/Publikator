import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';

type LibraryView = 'all' | 'inbox' | 'draft' | 'ready' | 'scheduled' | 'published' | 'problems';
type LibraryFormat = 'all' | 'stories' | 'shorts' | 'video' | 'image';

const VIEWS = new Set<LibraryView>(['all', 'inbox', 'draft', 'ready', 'scheduled', 'published', 'problems']);
const FORMATS = new Set<LibraryFormat>(['all', 'stories', 'shorts', 'video', 'image']);

function positiveInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`Ожидается целое число от 1 до ${max}`);
  return parsed;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function viewCondition(view: LibraryView): string | null {
  if (view === 'inbox') return "(p.editorial_stage='IDEA' OR (p.status='DRAFT' AND p.source_type IS NOT NULL AND LOWER(COALESCE(p.source_type,'')) NOT IN ('','manual')))";
  if (view === 'draft') return "p.status='DRAFT' AND p.editorial_stage IN ('DRAFT','IN_REVIEW')";
  if (view === 'ready') return "p.status='READY'";
  if (view === 'scheduled') return "p.schedule_mode IN ('AT','QUEUE') AND p.status IN ('DRAFT','READY','FAILED')";
  if (view === 'published') return "p.status IN ('PUBLISHED','PARTIAL')";
  if (view === 'problems') return "(p.status='FAILED' OR EXISTS (SELECT 1 FROM post_targets problem_target WHERE problem_target.post_id=p.id AND problem_target.state IN ('FAILED','RETRY','RECOVERY_NEEDED','PARTIAL')))";
  return null;
}

function formatCondition(format: LibraryFormat): string | null {
  if (format === 'stories') return "(p.publication_kind='STORY' OR p.content_format='STORY_SEQUENCE')";
  if (format === 'shorts') return "(p.publication_kind='SHORT' OR p.content_format='VERTICAL_VIDEO')";
  if (format === 'video') return "p.content_format IN ('VIDEO','VERTICAL_VIDEO')";
  if (format === 'image') return "p.content_format IN ('IMAGE','CAROUSEL')";
  return null;
}

export async function registerContentLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/content-library', async (request, reply) => {
    try {
      const query = request.query as { view?: string; format?: string; search?: string; page?: string; pageSize?: string };
      const view = String(query.view || 'all') as LibraryView;
      const format = String(query.format || 'all') as LibraryFormat;
      if (!VIEWS.has(view)) return reply.code(400).send({ error: 'Неизвестный view библиотеки' });
      if (!FORMATS.has(format)) return reply.code(400).send({ error: 'Неизвестный format библиотеки' });
      const page = positiveInteger(query.page, 1, 100_000);
      const pageSize = positiveInteger(query.pageSize, 24, 100);
      const search = String(query.search || '').trim();
      if (search.length > 200) return reply.code(400).send({ error: 'Поисковый запрос слишком длинный' });

      const conditions = ["p.editorial_stage NOT IN ('ARCHIVED','TRASHED')"];
      const values: unknown[] = [];
      const byView = viewCondition(view);
      const byFormat = formatCondition(format);
      if (byView) conditions.push(byView);
      if (byFormat) conditions.push(byFormat);
      if (search) {
        conditions.push(`(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\' OR pr.name LIKE ? ESCAPE '\\'
          OR COALESCE(p.source_type,'') LIKE ? ESCAPE '\\' OR COALESCE(p.source_ref,'') LIKE ? ESCAPE '\\')`);
        const pattern = `%${escapeLike(search)}%`;
        values.push(pattern, pattern, pattern, pattern, pattern);
      }
      const where = conditions.join(' AND ');
      const total = Number((db.prepare(`SELECT COUNT(*) AS count FROM posts p JOIN projects pr ON pr.id=p.project_id WHERE ${where}`)
        .get(...values) as { count: number }).count);
      const offset = (page - 1) * pageSize;
      const rows = db.prepare(`SELECT p.id,p.project_id,p.title,p.body,p.status,p.editorial_stage,p.schedule_mode,
          p.scheduled_at_utc,p.schedule_timezone,p.publication_kind,p.content_format,p.source_type,p.source_ref,
          p.content_version,p.created_at,p.updated_at,pr.name AS project_name,
          (SELECT COUNT(*) FROM media m WHERE m.post_id=p.id) AS media_count,
          (SELECT relative_path FROM media m WHERE m.post_id=p.id ORDER BY sort_order,created_at LIMIT 1) AS thumbnail_path,
          (SELECT GROUP_CONCAT(DISTINCT a.platform) FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
            WHERE pt.post_id=p.id AND pt.enabled=1) AS platforms_csv,
          (SELECT COUNT(*) FROM post_targets pt WHERE pt.post_id=p.id
            AND pt.state IN ('FAILED','RETRY','RECOVERY_NEEDED','PARTIAL')) AS problem_count
        FROM posts p JOIN projects pr ON pr.id=p.project_id
        WHERE ${where}
        ORDER BY COALESCE(p.scheduled_at_utc,p.updated_at,p.created_at) DESC,p.created_at DESC,p.id
        LIMIT ? OFFSET ?`).all(...values, pageSize, offset) as Array<Record<string, unknown> & { platforms_csv?: string | null }>;

      const items = rows.map(({ platforms_csv, ...row }) => ({
        ...row,
        platforms: platforms_csv ? platforms_csv.split(',').filter(Boolean) : []
      }));
      return { view, format, search, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), items };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
