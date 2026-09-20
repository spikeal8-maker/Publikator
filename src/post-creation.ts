import { db, id, nowIso } from './db.js';
import { createInitialContentRevision, type RevisionActorSource } from './content-versioning.js';
import { ensureTargets, setTargetSelection } from './publisher.js';

export type NewDraftPostInput = {
  projectId: string;
  title: string;
  body: string;
  bodyRichJson: string;
  scheduleMode: 'MANUAL' | 'AT' | 'QUEUE';
  scheduledAt?: string | null;
  scheduledAtUtc?: string | null;
  scheduleTimezone?: string | null;
  publicationKind?: 'FEED' | 'SHORT' | 'STORY';
  contentFormat?: 'TEXT_ONLY' | 'IMAGE' | 'CAROUSEL' | 'VIDEO' | 'VERTICAL_VIDEO' | 'STORY_SEQUENCE';
  targetAccountIds?: string[];
  actorSource?: RevisionActorSource;
};

export function createDraftPost(input: NewDraftPostInput): any {
  const project = db.prepare('SELECT id,default_timezone FROM projects WHERE id=?')
    .get(input.projectId) as { id: string; default_timezone: string } | undefined;
  if (!project) throw new Error('Проект не найден');
  if (!input.title.trim() || !input.body.trim()) throw new Error('Заголовок и текст обязательны');

  const postId = id('post');
  const publicationKind = input.publicationKind ?? 'FEED';
  const contentFormat = input.contentFormat ?? 'IMAGE';
  const scheduleTimezone = input.scheduleMode === 'AT'
    ? (input.scheduleTimezone ?? project.default_timezone)
    : null;
  const scheduledAt = input.scheduleMode === 'AT' ? (input.scheduledAt ?? null) : null;
  const scheduledAtUtc = input.scheduleMode === 'AT' ? (input.scheduledAtUtc ?? scheduledAt) : null;
  return db.transaction(() => {
    const now = nowIso();
    db.prepare(`INSERT INTO posts
      (id,project_id,title,body,body_rich_json,status,editorial_stage,schedule_mode,
       scheduled_at,scheduled_at_utc,schedule_timezone,publication_kind,content_format,
       content_version,created_at,updated_at)
      VALUES (?,?,?,?,?,'DRAFT','DRAFT',?,?,?,?,?,?,1,?,?)`)
      .run(
        postId, input.projectId, input.title.trim(), input.body, input.bodyRichJson,
        input.scheduleMode, scheduledAt, scheduledAtUtc, scheduleTimezone,
        publicationKind, contentFormat, now, now
      );

    if (input.targetAccountIds === undefined) ensureTargets(postId);
    else setTargetSelection(postId, input.targetAccountIds);

    createInitialContentRevision(postId, input.actorSource ?? 'manual');
    return db.prepare('SELECT * FROM posts WHERE id=?').get(postId);
  })();
}
