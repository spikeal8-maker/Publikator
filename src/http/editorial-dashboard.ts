import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';

type DashboardQuery = { todayFrom?: string; todayTo?: string; weekTo?: string };

const ACTIVE_STAGE_SQL = "COALESCE(p.editorial_stage,'DRAFT') NOT IN ('ARCHIVED','TRASHED')";
const PROBLEM_TARGET_STATES = ['FAILED', 'RETRY', 'RECOVERY_NEEDED'] as const;

function parseWindow(query: DashboardQuery): { todayFrom: string; todayTo: string; weekTo: string } {
  const todayFrom = String(query.todayFrom || '');
  const todayTo = String(query.todayTo || '');
  const weekTo = String(query.weekTo || '');
  const fromMs = Date.parse(todayFrom);
  const todayToMs = Date.parse(todayTo);
  const weekToMs = Date.parse(weekTo);
  if (![fromMs, todayToMs, weekToMs].every(Number.isFinite)) throw new Error('Dashboard requires valid UTC window boundaries');
  if (!(fromMs < todayToMs && todayToMs <= weekToMs)) throw new Error('Dashboard window boundaries are out of order');
  if (weekToMs - fromMs > 9 * 24 * 60 * 60 * 1000) throw new Error('Dashboard window is too large');
  return { todayFrom: new Date(fromMs).toISOString(), todayTo: new Date(todayToMs).toISOString(), weekTo: new Date(weekToMs).toISOString() };
}

function scalarCount(sql: string, ...params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { count?: number } | undefined)?.count || 0);
}

const itemSelect = `SELECT p.id,p.title,p.status,COALESCE(p.editorial_stage,'DRAFT') AS editorial_stage,
  p.schedule_mode,p.scheduled_at_utc,p.schedule_timezone,p.publication_kind,p.content_format,p.updated_at,
  pr.name AS project_name,
  (SELECT m.relative_path FROM content_media cm JOIN media m ON m.id=cm.media_id
    WHERE cm.post_id=p.id AND cm.role<>'poster' ORDER BY cm.position,cm.created_at LIMIT 1) AS thumbnail_path,
  (SELECT group_concat(DISTINCT a.platform) FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.post_id=p.id AND pt.enabled=1) AS platforms,
  (SELECT group_concat(DISTINCT pt.state) FROM post_targets pt
    WHERE pt.post_id=p.id AND pt.state IN ('FAILED','RETRY','RECOVERY_NEEDED')) AS problem_states
  FROM posts p JOIN projects pr ON pr.id=p.project_id`;

function reviewCode(stage: string): string {
  if (stage === 'IDEA') return 'IDEA_NEEDS_REVIEW';
  if (stage === 'IN_REVIEW') return 'IN_REVIEW';
  return 'DRAFT_NEEDS_REVIEW';
}

export async function registerEditorialDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/editorial-dashboard', async (request, reply) => {
    let window: { todayFrom: string; todayTo: string; weekTo: string };
    try { window = parseWindow(request.query as DashboardQuery); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }

    const metrics = {
      today: scalarCount(`SELECT COUNT(*) AS count FROM posts p WHERE ${ACTIVE_STAGE_SQL} AND p.schedule_mode='AT' AND p.scheduled_at_utc>=? AND p.scheduled_at_utc<?`, window.todayFrom, window.todayTo),
      next7Days: scalarCount(`SELECT COUNT(*) AS count FROM posts p WHERE ${ACTIVE_STAGE_SQL} AND p.schedule_mode='AT' AND p.scheduled_at_utc>=? AND p.scheduled_at_utc<?`, window.todayFrom, window.weekTo),
      needsReview: scalarCount(`SELECT COUNT(*) AS count FROM posts p WHERE ${ACTIVE_STAGE_SQL} AND COALESCE(p.editorial_stage,'DRAFT') IN ('IDEA','DRAFT','IN_REVIEW') AND p.status NOT IN ('PUBLISHING','PUBLISHED','PARTIAL')`),
      ready: scalarCount(`SELECT COUNT(*) AS count FROM posts p WHERE ${ACTIVE_STAGE_SQL} AND p.status='READY'`),
      problems: scalarCount(`SELECT COUNT(*) AS count FROM posts p WHERE ${ACTIVE_STAGE_SQL} AND (p.status IN ('FAILED','PARTIAL') OR EXISTS (SELECT 1 FROM post_targets pt WHERE pt.post_id=p.id AND pt.state IN ('FAILED','RETRY','RECOVERY_NEEDED')))`)
    };

    const todayItems = db.prepare(`${itemSelect} WHERE ${ACTIVE_STAGE_SQL} AND p.schedule_mode='AT' AND p.scheduled_at_utc>=? AND p.scheduled_at_utc<? ORDER BY p.scheduled_at_utc LIMIT 12`).all(window.todayFrom, window.todayTo);
    const reviewItems = (db.prepare(`${itemSelect} WHERE ${ACTIVE_STAGE_SQL} AND COALESCE(p.editorial_stage,'DRAFT') IN ('IDEA','DRAFT','IN_REVIEW') AND p.status NOT IN ('PUBLISHING','PUBLISHED','PARTIAL') ORDER BY p.updated_at DESC LIMIT 12`).all() as any[])
      .map((item) => ({ ...item, review_code: reviewCode(String(item.editorial_stage)) }));
    const problemItems = db.prepare(`${itemSelect} WHERE ${ACTIVE_STAGE_SQL} AND (p.status IN ('FAILED','PARTIAL') OR EXISTS (SELECT 1 FROM post_targets pt WHERE pt.post_id=p.id AND pt.state IN ('FAILED','RETRY','RECOVERY_NEEDED'))) ORDER BY p.updated_at DESC LIMIT 12`).all();
    const platformDistribution = db.prepare(`SELECT a.platform,COUNT(*) AS count FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id JOIN posts p ON p.id=pt.post_id WHERE pt.enabled=1 AND ${ACTIVE_STAGE_SQL} AND p.schedule_mode='AT' AND p.scheduled_at_utc>=? AND p.scheduled_at_utc<? GROUP BY a.platform ORDER BY a.platform`).all(window.todayFrom, window.weekTo);
    const recentEvents = db.prepare(`SELECT id,event_type,level,message,created_at,post_id,target_id FROM publication_events ORDER BY created_at DESC LIMIT 12`).all();

    return { window, metrics, platformDistribution, todayItems, reviewItems, problemItems, recentEvents, problemTargetStates: PROBLEM_TARGET_STATES };
  });
}
