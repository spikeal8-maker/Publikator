import { decryptJson } from './crypto.js';
import { db, event, nowIso, type Platform, type TargetState } from './db.js';
import { listMedia, mediaPublicUrl } from './media.js';
import { getPublisher } from './platforms/index.js';
import { PlatformError } from './platforms/types.js';

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

function retryTime(attempts: number): string | null {
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  return attempts <= RETRY_DELAYS_MS.length && delay ? new Date(Date.now() + delay).toISOString() : null;
}

export function ensureTargets(postId: string): void {
  const now = nowIso();
  const existing = db.prepare('SELECT COUNT(*) AS count FROM post_targets WHERE post_id=?').get(postId) as { count: number };
  const defaultEnabled = existing.count === 0 ? 1 : 0;
  const accounts = db.prepare('SELECT id FROM social_accounts WHERE enabled=1 ORDER BY created_at').all() as Array<{ id: string }>;
  const insert = db.prepare(`INSERT OR IGNORE INTO post_targets
    (id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (lower(hex(randomblob(16))),?,?,?,?,0,?)`);
  const tx = db.transaction(() => {
    for (const account of accounts) insert.run(postId, account.id, defaultEnabled, 'PENDING', now);
  });
  tx();
}

export function setTargetSelection(postId: string, accountIds: string[]): void {
  ensureTargets(postId);
  const allowed = new Set(
    (db.prepare('SELECT id FROM social_accounts WHERE enabled=1').all() as Array<{ id: string }>).map((row) => row.id)
  );
  const selected = [...new Set(accountIds)].filter((accountId) => allowed.has(accountId));
  const tx = db.transaction(() => {
    db.prepare("UPDATE post_targets SET enabled=0, updated_at=? WHERE post_id=? AND state!='PUBLISHED'").run(nowIso(), postId);
    const enable = db.prepare("UPDATE post_targets SET enabled=1, updated_at=? WHERE post_id=? AND account_id=? AND state!='PUBLISHED'");
    for (const accountId of selected) enable.run(nowIso(), postId, accountId);
  });
  tx();
}

export async function publishTarget(targetId: string): Promise<void> {
  const target = db.prepare(`SELECT pt.*, p.title, p.body, p.id AS post_id, a.platform, a.credentials_encrypted
    FROM post_targets pt
    JOIN posts p ON p.id=pt.post_id
    JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.id=?`).get(targetId) as any;
  if (!target) throw new Error('Цель публикации не найдена');
  const currentState = target.state as TargetState;
  if (currentState === 'PUBLISHED' || currentState === 'RECOVERY_NEEDED') return;

  const media = listMedia(target.post_id);
  if (media.length < 1) throw new Error('Публикация заблокирована: нет изображения');
  const publicMediaUrls = (target.platform === 'max' || target.platform === 'instagram') ? media.map(mediaPublicUrl) : [];
  const credentials = decryptJson<Record<string, unknown>>(target.credentials_encrypted);
  const publisher = getPublisher(target.platform as Platform);
  const text = target.override_text || target.body;

  const input = {
    postId: target.post_id,
    title: target.title,
    text,
    media,
    credentials,
    publicMediaUrls
  };

  try {
    publisher.validate(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE post_targets SET state='FAILED', next_attempt_at=NULL, last_error=?, updated_at=? WHERE id=?")
      .run(message, nowIso(), targetId);
    event({ postId: target.post_id, accountId: target.account_id, level: 'error', type: 'publish_validation_failed', message, data: { platform: target.platform } });
    return;
  }

  db.prepare("UPDATE post_targets SET state='PUBLISHING', attempts=attempts+1, last_error=NULL, updated_at=? WHERE id=?")
    .run(nowIso(), targetId);
  event({ postId: target.post_id, accountId: target.account_id, type: 'publish_started', message: `Публикация начата: ${target.platform}` });

  try {
    const result = await publisher.publish(input);
    db.prepare(`UPDATE post_targets SET state='PUBLISHED', external_id=?, external_url=?, published_at=?, next_attempt_at=NULL, updated_at=? WHERE id=?`)
      .run(result.externalId, result.externalUrl ?? null, nowIso(), nowIso(), targetId);
    event({ postId: target.post_id, accountId: target.account_id, type: 'publish_succeeded', message: `Опубликовано: ${target.platform}`, data: { externalId: result.externalId, externalUrl: result.externalUrl } });
  } catch (error) {
    const fresh = db.prepare('SELECT attempts FROM post_targets WHERE id=?').get(targetId) as { attempts: number };
    const message = error instanceof Error ? error.message : String(error);
    let state: TargetState;
    let next: string | null = null;

    if (error instanceof PlatformError) {
      next = error.retryable ? retryTime(fresh.attempts) : null;
      state = next ? 'RETRY' : 'FAILED';
    } else {
      state = 'RECOVERY_NEEDED';
    }

    const storedMessage = state === 'RECOVERY_NEEDED'
      ? `${message} Результат внешнего POST может быть неопределён; автоматический повтор отключён во избежание дубля.`
      : message;
    db.prepare('UPDATE post_targets SET state=?, next_attempt_at=?, last_error=?, updated_at=? WHERE id=?')
      .run(state, next, storedMessage, nowIso(), targetId);
    event({
      postId: target.post_id,
      accountId: target.account_id,
      level: 'error',
      type: state === 'RECOVERY_NEEDED' ? 'publish_recovery_needed' : 'publish_failed',
      message: storedMessage,
      data: { platform: target.platform, attempts: fresh.attempts, next, retryable: error instanceof PlatformError ? error.retryable : null }
    });
  }
}

export function refreshPostStatus(postId: string): void {
  const states = db.prepare("SELECT pt.state FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id WHERE pt.post_id=? AND pt.enabled=1 AND a.enabled=1").all(postId) as Array<{ state: TargetState }>;
  if (states.length === 0) return;
  const values = states.map((s) => s.state);
  let status = 'PUBLISHING';
  if (values.every((s) => s === 'PUBLISHED')) status = 'PUBLISHED';
  else if (values.some((s) => s === 'PUBLISHED') && values.some((s) => ['FAILED','RETRY','RECOVERY_NEEDED'].includes(s))) status = 'PARTIAL';
  else if (values.every((s) => s === 'FAILED')) status = 'FAILED';
  else if (values.some((s) => s === 'RECOVERY_NEEDED')) status = 'PARTIAL';
  db.prepare('UPDATE posts SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), postId);
}

export async function publishPost(postId: string): Promise<void> {
  const mediaCount = db.prepare('SELECT COUNT(*) AS count FROM media WHERE post_id=?').get(postId) as { count: number };
  if (mediaCount.count < 1) throw new Error('Публикация без изображения запрещена');
  ensureTargets(postId);
  const targetCount = db.prepare("SELECT COUNT(*) AS count FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id WHERE pt.post_id=? AND pt.enabled=1 AND a.enabled=1").get(postId) as { count: number };
  if (targetCount.count < 1) throw new Error('Не выбрана ни одна активная площадка для публикации');
  db.prepare("UPDATE posts SET status='PUBLISHING', updated_at=? WHERE id=?").run(nowIso(), postId);
  const targets = db.prepare("SELECT pt.id FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id WHERE pt.post_id=? AND pt.enabled=1 AND a.enabled=1 AND pt.state IN ('PENDING','RETRY','FAILED') ORDER BY pt.rowid").all(postId) as Array<{ id: string }>;
  for (const target of targets) await publishTarget(target.id);
  refreshPostStatus(postId);
}
