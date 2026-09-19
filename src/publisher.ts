import { decryptJson } from './crypto.js';
import { db, event, nowIso, type Platform, type TargetState } from './db.js';
import type { ContentFormat, PublicationKind } from './domain/content-domain.js';
import { mediaPublicUrl } from './media.js';
import { CapabilityValidationError, assertPlatformCapability, platformRequiresPublicHttpsMedia } from './platforms/capabilities.js';
import { getPublisher } from './platforms/index.js';
import { PlatformError, type PublishInput } from './platforms/types.js';
import {
  compilePlatformText,
  resolveTargetRichText,
  type PlatformTextContext,
  type PlatformTextDiagnostic
} from './platform-text.js';
import { beginPublicationActivity } from './runtime-gate.js';
import { getContentRevision, revisionMedia, revisionTargets, type ContentRevisionRow } from './content-versioning.js';
import {
  claimNextPublicationUnit,
  confirmPublicationUnitNotPublished,
  ensurePublicationUnits,
  listPublicationUnits,
  markPublicationUnitFailed,
  markPublicationUnitPublished,
  markPublicationUnitRecoveryNeeded,
  retryFailedPublicationUnit,
  syncAggregateTargetState,
  type PublicationUnitRow
} from './delivery-foundation.js';

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const CLAIMABLE_TARGET_STATES: TargetState[] = ['PENDING', 'RETRY', 'FAILED'];
const PUBLICATION_KINDS = new Set<PublicationKind>(['FEED', 'SHORT', 'STORY']);
const CONTENT_FORMATS = new Set<ContentFormat>(['TEXT_ONLY', 'IMAGE', 'CAROUSEL', 'VIDEO', 'VERTICAL_VIDEO', 'STORY_SEQUENCE']);

type PublishTargetRow = {
  id: string;
  post_id: string;
  account_id: string;
  enabled: number;
  state: TargetState;
  platform: Platform;
  account_name?: string;
  account_enabled?: number;
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

type UnitContext = PublicationUnitRow & {
  post_id: string;
  account_id: string;
  platform: Platform;
  account_name: string;
};

export type PreflightIssue = {
  targetId: string;
  accountId: string;
  platform: Platform;
  accountName: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  code?: string;
};

export type PreflightResult = {
  ok: boolean;
  issues: PreflightIssue[];
};

function retryTime(attempts: number): string | null {
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  return attempts <= RETRY_DELAYS_MS.length && delay ? new Date(Date.now() + delay).toISOString() : null;
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

function unitContext(unitId: string): UnitContext {
  const row = db.prepare(`SELECT pu.*,pt.post_id,pt.account_id,a.platform,a.name AS account_name
    FROM publication_units pu
    JOIN post_targets pt ON pt.id=pu.target_id
    JOIN social_accounts a ON a.id=pt.account_id
    WHERE pu.id=?`).get(unitId) as UnitContext | undefined;
  if (!row) throw new Error('PublicationUnit не найдена');
  return row;
}

function targetHasUnits(targetId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM publication_units WHERE target_id=? LIMIT 1').get(targetId));
}

function assertTargetLevelRecoveryAllowed(targetId: string): void {
  if (targetHasUnits(targetId)) {
    throw new Error('Для multi-unit target запрещён общий retry/recovery. Используйте PublicationUnit recovery.');
  }
}

function validExternalUrl(value: string | null | undefined): string | null {
  const clean = value?.trim() || null;
  if (!clean) return null;
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    throw new Error('externalUrl должен быть корректным URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('externalUrl должен использовать http или https');
  return clean;
}

function claimTarget(targetId: string, revisionId: string): boolean {
  const claimed = db.prepare(`UPDATE post_targets
    SET state='PUBLISHING', attempts=attempts+1, next_attempt_at=NULL, last_error=NULL, updated_at=?
    WHERE id=? AND enabled=1 AND state IN ('PENDING','RETRY','FAILED')
      AND EXISTS (
        SELECT 1 FROM posts p
        JOIN content_revisions cr ON cr.id=p.ready_revision_id
        WHERE p.id=post_targets.post_id
          AND cr.id=?
          AND cr.content_version=p.content_version
          AND p.editorial_stage='APPROVED'
          AND p.status IN ('PUBLISHING','PARTIAL','FAILED')
      )`)
    .run(nowIso(), targetId, revisionId);
  return claimed.changes === 1;
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

function revisionTargetRow(targetId: string): PublishTargetRow | undefined {
  return db.prepare(`SELECT pt.*, p.id AS post_id,
      a.platform, a.name AS account_name, a.enabled AS account_enabled, a.credentials_encrypted
    FROM post_targets pt
    JOIN posts p ON p.id=pt.post_id
    JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.id=?`).get(targetId) as PublishTargetRow | undefined;
}

function resolvedPublicationKind(value: string | null | undefined, fallback: PublicationKind): PublicationKind {
  if (value == null) return fallback;
  if (!PUBLICATION_KINDS.has(value as PublicationKind)) throw new Error(`Некорректный publication kind в target rendition: ${value}`);
  return value as PublicationKind;
}

function resolvedContentFormat(value: string | null | undefined, fallback: string): ContentFormat {
  const candidate = value ?? fallback;
  if (!CONTENT_FORMATS.has(candidate as ContentFormat)) throw new Error(`Некорректный content format в target rendition: ${candidate}`);
  return candidate as ContentFormat;
}

function textContext(publicationKind: PublicationKind, mediaCount: number): PlatformTextContext {
  if (publicationKind === 'STORY') return 'story_caption';
  return mediaCount > 0 ? 'media_caption' : 'text';
}

function mergeCompilationDiagnostics(input: PublishInput, diagnostics: PlatformTextDiagnostic[]): PublishInput {
  if (!input.textCompilation || diagnostics.length === 0) return input;
  return {
    ...input,
    textCompilation: {
      ...input.textCompilation,
      diagnostics: [...diagnostics, ...input.textCompilation.diagnostics]
    }
  };
}

export function buildRevisionPublishInput(target: PublishTargetRow, revision: ContentRevisionRow): PublishInput {
  const targetSnapshot = revisionTargets(revision).find((item) => item.targetId === target.id && item.accountId === target.account_id && item.enabled);
  if (!targetSnapshot) throw new Error('Цель не входит в immutable READY revision');
  const media = revisionMedia(revision);
  const credentials = decryptJson<Record<string, unknown>>(target.credentials_encrypted);
  const publicationKind = resolvedPublicationKind(targetSnapshot.rendition?.publicationKind, revision.publication_kind);
  const contentFormat = resolvedContentFormat(targetSnapshot.rendition?.contentFormat, revision.content_format);
  const publicMediaUrls = platformRequiresPublicHttpsMedia(target.platform, contentFormat) ? media.map(mediaPublicUrl) : [];
  const resolvedText = resolveTargetRichText({
    baseRichJson: revision.body_rich_json,
    basePlain: revision.body,
    renditionRichJson: targetSnapshot.rendition?.textRichJson,
    renditionPlain: targetSnapshot.rendition?.textPlain,
    legacyOverride: targetSnapshot.overrideText
  });
  const compilation = compilePlatformText(target.platform, resolvedText.document, textContext(publicationKind, media.length));
  return mergeCompilationDiagnostics({
    postId: target.post_id,
    title: revision.title,
    text: compilation.plainText,
    textCompilation: compilation,
    media,
    credentials,
    publicMediaUrls,
    publicationKind,
    contentFormat
  }, resolvedText.diagnostics);
}

function compilerIssues(target: PublishTargetRow, input: PublishInput): PreflightIssue[] {
  return (input.textCompilation?.diagnostics ?? []).map((diagnostic) => ({
    targetId: target.id,
    accountId: target.account_id,
    platform: target.platform,
    accountName: target.account_name || target.platform,
    severity: diagnostic.severity,
    message: diagnostic.message,
    code: diagnostic.code
  }));
}

function assertCompilationPublishable(input: PublishInput): void {
  const errors = input.textCompilation?.diagnostics.filter((item) => item.severity === 'error') ?? [];
  if (errors.length) throw new Error(`Rich-text compilation blocked: ${errors.map((item) => item.code).join(', ')}`);
}

export function preflightRevision(revisionId: string): PreflightResult {
  const revision = getContentRevision(revisionId);
  const issues: PreflightIssue[] = [];
  for (const snapshot of revisionTargets(revision).filter((target) => target.enabled)) {
    const target = revisionTargetRow(snapshot.targetId);
    if (!target || target.account_id !== snapshot.accountId) {
      issues.push({ targetId: snapshot.targetId, accountId: snapshot.accountId, platform: 'telegram', accountName: snapshot.accountId, severity: 'error', message: 'Цель READY revision больше не существует' });
      continue;
    }
    if (!target.account_enabled) {
      issues.push({ targetId: target.id, accountId: target.account_id, platform: target.platform, accountName: target.account_name || target.platform, severity: 'error', message: 'Аккаунт отключён' });
      continue;
    }
    try {
      const input = buildRevisionPublishInput(target, revision);
      issues.push(...compilerIssues(target, input));
      assertPlatformCapability(target.platform, input);
      getPublisher(target.platform).validate(input);
    } catch (error) {
      if (error instanceof CapabilityValidationError) {
        for (const capabilityIssue of error.issues) {
          issues.push({
            targetId: target.id,
            accountId: target.account_id,
            platform: target.platform,
            accountName: target.account_name || target.platform,
            severity: 'error',
            message: capabilityIssue.message,
            code: capabilityIssue.code
          });
        }
      } else {
        issues.push({
          targetId: target.id,
          accountId: target.account_id,
          platform: target.platform,
          accountName: target.account_name || target.platform,
          severity: 'error',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}

function isStorySequence(input: PublishInput): boolean {
  return input.publicationKind === 'STORY' && input.contentFormat === 'STORY_SEQUENCE';
}

async function executeStorySequence(target: PublishTargetRow, revision: ContentRevisionRow, input: PublishInput): Promise<void> {
  const platformPublisher = getPublisher(target.platform);
  if (!platformPublisher.publishUnit) throw new Error(`${target.platform}: adapter не реализует PublicationUnit execution`);

  const units = ensurePublicationUnits(target.id, revision.id, input.media.map(() => 'STORY'));
  if (units.length !== input.media.length) throw new Error('PublicationUnit plan не соответствует immutable media sequence');

  event({
    postId: target.post_id,
    accountId: target.account_id,
    type: 'sequence_publish_started',
    message: `Sequence publication: ${target.platform}`,
    data: { revisionId: revision.id, units: units.length }
  });

  while (true) {
    const unit = claimNextPublicationUnit(target.id);
    if (!unit) break;
    event({
      postId: target.post_id,
      accountId: target.account_id,
      type: 'publication_unit_started',
      message: `Story ${unit.unit_index + 1} started`,
      data: { unitId: unit.id, unitIndex: unit.unit_index }
    });

    try {
      const result = await platformPublisher.publishUnit(input, unit.unit_index);
      markPublicationUnitPublished(unit.id, result.externalId, result.externalUrl ?? null);
      event({
        postId: target.post_id,
        accountId: target.account_id,
        type: 'publication_unit_succeeded',
        message: `Story ${unit.unit_index + 1} published`,
        data: { unitId: unit.id, unitIndex: unit.unit_index, externalId: result.externalId }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PlatformError && !error.outcomeUnknown) {
        markPublicationUnitFailed(unit.id, message);
        event({
          postId: target.post_id,
          accountId: target.account_id,
          level: 'error',
          type: 'publication_unit_failed',
          message,
          data: { unitId: unit.id, unitIndex: unit.unit_index, retryable: error.retryable }
        });
      } else {
        const storedMessage = `${message} Результат внешнего POST этой Story может быть неопределён; автоматический повтор отключён.`;
        markPublicationUnitRecoveryNeeded(unit.id, storedMessage);
        event({
          postId: target.post_id,
          accountId: target.account_id,
          level: 'error',
          type: 'publication_unit_recovery_needed',
          message: storedMessage,
          data: { unitId: unit.id, unitIndex: unit.unit_index }
        });
      }
      break;
    }
  }

  const state = syncAggregateTargetState(target.id);
  if (state === 'PUBLISHED') {
    db.prepare(`UPDATE post_targets
      SET published_at=COALESCE(published_at,?),next_attempt_at=NULL,last_error=NULL,updated_at=?
      WHERE id=?`).run(nowIso(), nowIso(), target.id);
  }
}

async function publishTargetInternal(targetId: string, forcedRevisionId?: string): Promise<void> {
  const target = revisionTargetRow(targetId);
  if (!target) throw new Error('Цель публикации не найдена');
  if (!target.enabled || !target.account_enabled || !CLAIMABLE_TARGET_STATES.includes(target.state)) return;

  const post = db.prepare('SELECT ready_revision_id FROM posts WHERE id=?').get(target.post_id) as { ready_revision_id: string | null } | undefined;
  const revisionId = forcedRevisionId ?? post?.ready_revision_id ?? null;
  if (!revisionId) throw new Error('Публикация заблокирована: отсутствует immutable READY revision');
  const revision = getContentRevision(revisionId);
  const platformPublisher = getPublisher(target.platform);
  let input: PublishInput;

  try {
    input = buildRevisionPublishInput(target, revision);
    assertCompilationPublishable(input);
    assertPlatformCapability(target.platform, input);
    platformPublisher.validate(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = db.prepare(`UPDATE post_targets
      SET state='FAILED', next_attempt_at=NULL, last_error=?, updated_at=?
      WHERE id=? AND enabled=1 AND state IN ('PENDING','RETRY','FAILED')`)
      .run(message, nowIso(), targetId);
    if (failed.changes === 1) {
      event({ postId: target.post_id, accountId: target.account_id, level: 'error', type: 'publish_validation_failed', message, data: { platform: target.platform, revisionId } });
    }
    return;
  }

  if (isStorySequence(input)) {
    await executeStorySequence(target, revision, input);
    return;
  }

  if (!claimTarget(targetId, revisionId)) return;
  event({ postId: target.post_id, accountId: target.account_id, type: 'publish_started', message: `Публикация начата: ${target.platform}` });

  try {
    const result = await platformPublisher.publish(input);
    db.prepare(`UPDATE post_targets SET state='PUBLISHED', external_id=?, external_url=?, published_at=?, next_attempt_at=NULL, updated_at=? WHERE id=? AND state='PUBLISHING'`)
      .run(result.externalId, result.externalUrl ?? null, nowIso(), nowIso(), targetId);
    event({ postId: target.post_id, accountId: target.account_id, type: 'publish_succeeded', message: `Опубликовано: ${target.platform}`, data: { externalId: result.externalId, externalUrl: result.externalUrl } });
  } catch (error) {
    const fresh = db.prepare('SELECT attempts,state FROM post_targets WHERE id=?').get(targetId) as { attempts: number; state: TargetState } | undefined;
    if (!fresh || fresh.state !== 'PUBLISHING') return;
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
    db.prepare("UPDATE post_targets SET state=?, next_attempt_at=?, last_error=?, updated_at=? WHERE id=? AND state='PUBLISHING'")
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
  else if (values.some((s) => s === 'PARTIAL' || s === 'RECOVERY_NEEDED')) status = 'PARTIAL';
  else if (values.some((s) => s === 'PUBLISHED') && values.some((s) => s !== 'PUBLISHED')) status = 'PARTIAL';
  else if (values.every((s) => s === 'FAILED')) status = 'FAILED';
  db.prepare('UPDATE posts SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), postId);
}

export async function retryFailedTarget(targetId: string): Promise<void> {
  assertTargetLevelRecoveryAllowed(targetId);
  const target = recoveryTarget(targetId);
  if (!target.enabled || !target.account_enabled) throw new Error('Цель или аккаунт отключены');
  if (!['FAILED', 'RETRY'].includes(target.state)) {
    if (target.state === 'RECOVERY_NEEDED') {
      throw new Error('Повтор заблокирован: сначала вручную проверьте площадку и разрешите RECOVERY_NEEDED');
    }
    throw new Error(`Повтор недоступен для состояния ${target.state}`);
  }
  const reset = db.prepare("UPDATE post_targets SET state='PENDING',next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND state IN ('FAILED','RETRY')")
    .run(nowIso(), targetId);
  if (reset.changes !== 1) throw new Error('Цель уже была захвачена другим процессом публикации');
  await publishTarget(targetId);
  refreshPostStatus(target.post_id);
}

export function confirmRecoveryPublished(targetId: string, externalId?: string | null, externalUrl?: string | null): { postId: string } {
  assertTargetLevelRecoveryAllowed(targetId);
  const target = recoveryTarget(targetId);
  if (target.state !== 'RECOVERY_NEEDED') throw new Error(`Ручное подтверждение недоступно для состояния ${target.state}`);
  const cleanExternalId = externalId?.trim() || null;
  const cleanExternalUrl = validExternalUrl(externalUrl);
  const previousError = target.last_error;
  const now = nowIso();
  const updated = db.prepare(`UPDATE post_targets SET state='PUBLISHED',external_id=?,external_url=?,published_at=?,next_attempt_at=NULL,last_error=NULL,updated_at=?
    WHERE id=? AND state='RECOVERY_NEEDED'`)
    .run(cleanExternalId, cleanExternalUrl, now, now, targetId);
  if (updated.changes !== 1) throw new Error('Состояние recovery уже изменено другим запросом');
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
  assertTargetLevelRecoveryAllowed(targetId);
  const target = recoveryTarget(targetId);
  if (target.state !== 'RECOVERY_NEEDED') throw new Error(`Ручное подтверждение недоступно для состояния ${target.state}`);
  const previousError = target.last_error;
  const message = 'Ручная проверка: публикация на внешней площадке не найдена. Обычный ручной повтор снова разрешён.';
  const updated = db.prepare("UPDATE post_targets SET state='FAILED',next_attempt_at=NULL,last_error=?,updated_at=? WHERE id=? AND state='RECOVERY_NEEDED'")
    .run(message, nowIso(), targetId);
  if (updated.changes !== 1) throw new Error('Состояние recovery уже изменено другим запросом');
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

export function retrySequenceUnit(unitId: string): { postId: string; targetId: string } {
  const unit = unitContext(unitId);
  retryFailedPublicationUnit(unitId);
  event({
    postId: unit.post_id,
    accountId: unit.account_id,
    level: 'warning',
    type: 'publication_unit_retry_allowed',
    message: `Story ${unit.unit_index + 1} разрешена к повтору`,
    data: { unitId, unitIndex: unit.unit_index }
  });
  refreshPostStatus(unit.post_id);
  return { postId: unit.post_id, targetId: unit.target_id };
}

export function confirmSequenceUnitNotPublished(unitId: string): { postId: string; targetId: string } {
  const unit = unitContext(unitId);
  confirmPublicationUnitNotPublished(unitId);
  event({
    postId: unit.post_id,
    accountId: unit.account_id,
    level: 'warning',
    type: 'publication_unit_recovery_confirmed_absent',
    message: `Story ${unit.unit_index + 1}: внешняя публикация не найдена`,
    data: { unitId, unitIndex: unit.unit_index }
  });
  refreshPostStatus(unit.post_id);
  return { postId: unit.post_id, targetId: unit.target_id };
}

export function confirmSequenceUnitPublished(unitId: string, externalId: string, externalUrl?: string | null): { postId: string; targetId: string } {
  const unit = unitContext(unitId);
  if (unit.state !== 'RECOVERY_NEEDED') throw new Error(`PublicationUnit не находится в RECOVERY_NEEDED: ${unit.state}`);
  const cleanExternalId = externalId.trim();
  if (!cleanExternalId) throw new Error('externalId обязателен для ручного подтверждения опубликованной Story');
  const cleanExternalUrl = validExternalUrl(externalUrl);
  markPublicationUnitPublished(unitId, cleanExternalId, cleanExternalUrl);
  event({
    postId: unit.post_id,
    accountId: unit.account_id,
    type: 'publication_unit_recovery_confirmed_published',
    message: `Story ${unit.unit_index + 1}: публикация подтверждена вручную`,
    data: { unitId, unitIndex: unit.unit_index, externalId: cleanExternalId, externalUrl: cleanExternalUrl }
  });
  refreshPostStatus(unit.post_id);
  return { postId: unit.post_id, targetId: unit.target_id };
}

export async function continuePublicationSequence(targetId: string): Promise<{ postId: string }> {
  const releasePublication = beginPublicationActivity();
  try {
    const target = revisionTargetRow(targetId);
    if (!target || !target.enabled || !target.account_enabled) throw new Error('Цель sequence не найдена или отключена');

    const units = listPublicationUnits(targetId);
    if (!units.length) throw new Error('PublicationUnit plan отсутствует');
    const revision = getContentRevision(units[0]!.revision_id);
    if (units.some((unit) => unit.revision_id !== revision.id)) throw new Error('PublicationUnit plan содержит разные revisions');

    const post = db.prepare('SELECT status,editorial_stage,content_version,ready_revision_id FROM posts WHERE id=?')
      .get(target.post_id) as { status: string; editorial_stage: string; content_version: number; ready_revision_id: string | null } | undefined;
    if (!post || post.editorial_stage !== 'APPROVED') {
      throw new Error('Sequence continuation заблокирован: post больше не находится в APPROVED');
    }
    if (post.ready_revision_id !== revision.id || post.content_version !== revision.content_version) {
      throw new Error('Sequence continuation заблокирован: immutable READY revision больше не является текущей');
    }
    if (!['PUBLISHING', 'PARTIAL', 'FAILED'].includes(post.status)) {
      throw new Error(`Sequence continuation недоступен для post status ${post.status}`);
    }

    const input = buildRevisionPublishInput(target, revision);
    if (!isStorySequence(input)) throw new Error('Target больше не является STORY_SEQUENCE');
    assertPlatformCapability(target.platform, input);
    getPublisher(target.platform).validate(input);
    await executeStorySequence(target, revision, input);
    refreshPostStatus(target.post_id);
    return { postId: target.post_id };
  } finally {
    releasePublication();
  }
}

export async function publishPost(postId: string): Promise<void> {
  const releasePublication = beginPublicationActivity();
  try {
    const post = db.prepare('SELECT status,editorial_stage,content_version,ready_revision_id FROM posts WHERE id=?')
      .get(postId) as { status: string; editorial_stage: string; content_version: number; ready_revision_id: string | null } | undefined;
    if (!post) throw new Error('Пост не найден');
    if (post.status === 'PUBLISHING') return;
    if (post.status !== 'READY' || post.editorial_stage !== 'APPROVED' || !post.ready_revision_id) {
      throw new Error('Публикация разрешена только для READY-поста с immutable revision');
    }

    const revision = getContentRevision(post.ready_revision_id);
    if (revision.post_id !== postId || revision.content_version !== post.content_version) {
      throw new Error('READY revision не соответствует текущей версии поста');
    }
    const preflight = preflightRevision(revision.id);
    if (!preflight.ok) throw new Error(`Публикация не прошла preflight:\n${formatPreflightIssues(preflight.issues)}`);

    const claimed = db.prepare(`UPDATE posts SET status='PUBLISHING',updated_at=?
      WHERE id=? AND status='READY' AND editorial_stage='APPROVED' AND content_version=? AND ready_revision_id=?
        AND EXISTS (SELECT 1 FROM content_revisions cr WHERE cr.id=? AND cr.post_id=posts.id AND cr.content_version=posts.content_version)`)
      .run(nowIso(), postId, revision.content_version, revision.id, revision.id);
    if (claimed.changes !== 1) return;

    const targets = revisionTargets(revision).filter((target) => target.enabled);
    for (const target of targets) await publishTargetInternal(target.targetId, revision.id);
    refreshPostStatus(postId);
  } finally {
    releasePublication();
  }
}
