import { decryptJson } from './crypto.js';
import { db, event, nowIso, type Platform, type TargetState } from './db.js';
import { listMedia, mediaPublicUrl } from './media.js';
import { getPublisher } from './platforms/index.js';
import { PlatformError, type PublishInput } from './platforms/types.js';
import { beginPublicationActivity } from './runtime-gate.js';

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

type PublishTargetRow = {
  id: string;
  post_id: string;
  account_id: string;
  enabled: number;
  override_text: string | null;
  state: TargetState;
  title: string;
  body: string;
  platform: Platform;
  account_name?: string;
  credentials_encrypted: string;
};

type RecoveryTargetRow = {
  id: string;
  post_id: string;
  account_id: string;
  state: TargetState;
  enabled: number;
  last_error: string | null;
  platform: Platform;
  account_name: string;
  account_enabled: number;
};

export type PreflightIssue = {
  targetId: string;
  accountId: string;
  platform: Platform;
  accountName: string;
  message: string;
};

export type PreflightResult = {
  ok: boolean;
  issues: PreflightIssue[];
};

function retryTime(attempts: number): string | null {
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  return attempts <= RETRY_DELAYS_MS.length && delay ? new Date(Date.now() + delay).toISOString() : null;
}

function buildPublishInput(target: PublishTargetRow): PublishInput {
  const media = listMedia(target.post_id);
  const publicMediaUrls = (target.platform === 'max' || target.platform === 'instagram') ? media.map(mediaPublicUrl) : [];
  const credentials = decryptJson<Record<string, unknown>>(target.credentials_encrypted);
  return {
    postId: target.post_id,
    title: target.title,
    text: target.override_text ?? target.body,
    media,
    credentials,
    publicMediaUrls
  };
}

function formatPreflightIssues(issues: PreflightIssue[]): string {
  return issues.map((issue) => `${issue.platform} / ${issue.accountName}: ${issue.message}`).join('\n');
}

function recoveryTarget(targetId: string): RecoveryTargetRow {
  const row = db.prepare(`SELECT pt.id,pt.post_id,pt.account_id,pt.state,pt.enabled,pt.last_error,
      a.platform,a.name AS account_name,a.enabled AS account_enabled
    FROM post_targets pt
    JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.id=?`).get(targetId) as RecoveryTargetRow | undefined;
  if (!row) throw new Error('Цель публикации не найдена');
  return row;
}

export function ensureTargets(postId: string): void {
  const now = nowIso();
  const post = db.prepare('SELECT created_at FROM posts WHERE id=?').get(postId) as { created_at: string } | undefined;
  if (!post) throw new Error('Пост не найден');
  const accounts = db.prepare('SELECT id,created_at FROM social_accounts WHERE enabled=1 ORDER BY created_at').all() as Array<{ id: string; created_at: string }>;
  const insert = db.prepare(`INSERT OR IGNORE INTO post_targets
    (id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (lower(hex(randomblob(16))),?,?,?,?,0,?)`);
  const tx = db.transaction(() => {
    for (const account of accounts) {
      const existedWhenPostWasCreated = account.created_at <= post.created_at ? 1 : 0;
      insert.run(postId, account.id, existedWhenPostWasCreated, 'PENDING', now);
    }
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

export function preflightPost(postId: string): PreflightResult {
  ensureTargets(postId);
  const targets = db.prepare(`SELECT pt.id,pt.post_id,pt.account_id,pt.enabled,pt.override_text,pt.state,
      p.title,p.body,a.platform,a.name AS account_name,a.credentials_encrypted
    FROM post_targets pt
    JOIN posts p ON p.id=pt.post_id
    JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.post_id=? AND pt.enabled=1 AND a.enabled=1
    ORDER BY a.platform,a.name`).all(postId) as PublishTargetRow[];

  const issues: PreflightIssue[] = [];
  for (const target of targets) {
    try {
      const input = buildPublishInput(target);
      getPublisher(target.platform).validate(input);
    } catch (error) {
      issues.push({
        targetId: target.id,
        accountId: target.account_id,
        platform: target.platform,
        accountName: target.account_name || target.platform,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

async function publishTargetInternal(targetId: string): Promise<void> {
  const target = db.prepare(`SELECT pt.*, p.title, p.body, p.id AS post_id, a.platform, a.name AS account_name, a.credentials_encrypted
    FROM post_targets pt
    JOIN posts p ON p.id=pt.post_id
    JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.id=?`).get(targetId) as PublishTargetRow | undefined;
  if (!target) throw new Error('Цель публикации не найдена');
  const currentState = target.state as TargetState;
  if (currentState === 'PUBLISHED' || currentState === 'RECOVERY_NEEDED') return;

  const media = listMedia(target.post_id);
  if (media.length < 1) throw new Error('Публикация заблокирована: нет изображения');
  const publisher = getPublisher(target.platform);
  let input: PublishInput;

  try {
    input = buildPublishInput(target);
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
      if (error.outcomeUnknown) {
        state = 'RECOVERY_NEEDED';
      } else {
        next = error.retryable ? retryTime(fresh.attempts) : null;
        state = next ? 'RETRY' : 'FAILED';
      }
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
      data: { platform: target.platform, attempts: fresh.attempts, next, retryable: error instanceof PlatformError ? error.retryable : null, outcomeUnknown: error instanceof PlatformError ? error.outcomeUnknown : true }
    });
  }
}

export async function publishTarget(targetId: string): Promise<void> {
  const releasePublication = beginPublicationActivity();
  try {
    await publishTargetInternal(targetId);
  } finally {
    releasePublication();
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

export async function retryFailedTarget(targetId: string): Promise<void> {
  const target = recoveryTarget(targetId);
  if (!target.enabled || !target.account_enabled) throw new Error('Цель или аккаунт отключены');
  if (!['FAILED', 'RETRY'].includes(target.state)) {
    if (target.state === 'RECOVERY_NEEDED') {
      throw new Error('Повтор заблокирован: сначала вручную проверьте площадку и разрешите RECOVERY_NEEDED');
    }
    throw new Error(`Повтор недоступен для состояния ${target.state}`);
  }
  db.prepare("UPDATE post_targets SET state='PENDING',next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE id=?")
    .run(nowIso(), targetId);
  await publishTarget(targetId);
  refreshPostStatus(target.post_id);
}

export function confirmRecoveryPublished(targetId: string, externalId?: string | null, externalUrl?: string | null): { postId: string } {
  const target = recoveryTarget(targetId);
  if (target.state !== 'RECOVERY_NEEDED') throw new Error(`Ручное подтверждение недоступно для состояния ${target.state}`);
  const cleanExternalId = externalId?.trim() || null;
  const cleanExternalUrl = externalUrl?.trim() || null;
  if (cleanExternalUrl) {
    let parsed: URL;
    try { parsed = new URL(cleanExternalUrl); } catch { throw new Error('externalUrl должен быть корректным URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('externalUrl должен использовать http или https');
  }
  const previousError = target.last_error;
  const now = nowIso();
  db.prepare(`UPDATE post_targets SET state='PUBLISHED',external_id=?,external_url=?,published_at=?,next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE id=?`)
    .run(cleanExternalId, cleanExternalUrl, now, now, targetId);
  event({
    postId: target.post_id,
    accountId: target.account_id,
    type: 'publish_recovery_confirmed_published',
    message: `Ручная проверка: публикация подтверждена на ${target.platform} / ${target.account_name}`,
    data: { previousError, externalId: cleanExternalId, externalUrl: cleanExternalUrl }
  });
  refreshPostStatus(target.post_id);
  return { postId: target.post_id };
}

export function confirmRecoveryNotPublished(targetId: string): { postId: string } {
  const target = recoveryTarget(targetId);
  if (target.state !== 'RECOVERY_NEEDED') throw new Error(`Ручное подтверждение недоступно для состояния ${target.state}`);
  const previousError = target.last_error;
  const message = 'Ручная проверка: публикация на внешней площадке не найдена. Обычный ручной повтор снова разрешён.';
  db.prepare("UPDATE post_targets SET state='FAILED',next_attempt_at=NULL,last_error=?,updated_at=? WHERE id=?")
    .run(message, nowIso(), targetId);
  event({
    postId: target.post_id,
    accountId: target.account_id,
    level: 'warning',
    type: 'publish_recovery_confirmed_absent',
    message: `Ручная проверка: публикация не найдена на ${target.platform} / ${target.account_name}`,
    data: { previousError }
  });
  refreshPostStatus(target.post_id);
  return { postId: target.post_id };
}

export async function publishPost(postId: string): Promise<void> {
  const releasePublication = beginPublicationActivity();
  try {
    const mediaCount = db.prepare('SELECT COUNT(*) AS count FROM media WHERE post_id=?').get(postId) as { count: number };
    if (mediaCount.count < 1) throw new Error('Публикация без изображения запрещена');
    ensureTargets(postId);
    const targetCount = db.prepare("SELECT COUNT(*) AS count FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id WHERE pt.post_id=? AND pt.enabled=1 AND a.enabled=1").get(postId) as { count: number };
    if (targetCount.count < 1) throw new Error('Не выбрана ни одна активная площадка для публикации');
    const preflight = preflightPost(postId);
    if (!preflight.ok) throw new Error(`Публикация не прошла preflight:\n${formatPreflightIssues(preflight.issues)}`);

    db.prepare("UPDATE posts SET status='PUBLISHING', updated_at=? WHERE id=?").run(nowIso(), postId);
    const targets = db.prepare("SELECT pt.id FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id WHERE pt.post_id=? AND pt.enabled=1 AND a.enabled=1 AND pt.state IN ('PENDING','RETRY','FAILED') ORDER BY pt.rowid").all(postId) as Array<{ id: string }>;
    for (const target of targets) await publishTargetInternal(target.id);
    refreshPostStatus(postId);
  } finally {
    releasePublication();
  }
}
