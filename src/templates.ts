import { db, event, id, nowIso } from './db.js';
import { createDraftPost } from './post-creation.js';
import { parseRichTextJson, richTextToPlain, serializeRichText } from './rich-text.js';

const TEMPLATE_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const PUBLICATION_KINDS = new Set(['FEED','SHORT','STORY']);
const CONTENT_FORMATS = new Set(['TEXT_ONLY','IMAGE','CAROUSEL','VIDEO','VERTICAL_VIDEO','STORY_SEQUENCE']);
const SCHEDULE_MODES = new Set(['MANUAL','AT','QUEUE']);
const TEMPLATE_TYPES = new Set(['POST','SNIPPET','CTA','SIGNATURE','HASHTAG_SET']);
const REUSABLE_BLOCK_TYPES = new Set(['SNIPPET','CTA','SIGNATURE','HASHTAG_SET']);

export class TemplateValidationError extends Error {}
export class TemplateNotFoundError extends Error {}

export type TemplateMutationInput = {
  key?: unknown;
  name?: unknown;
  projectId?: unknown;
  bodyRich?: unknown;
  templateType?: unknown;
  publicationKind?: unknown;
  contentFormat?: unknown;
  scheduleMode?: unknown;
  targetAccountIds?: unknown;
};

type TemplateRow = {
  id: string;
  key: string;
  name: string;
  project_id: string;
  project_name?: string;
  template_type: string;
  body_rich_json: string;
  body_plain: string;
  publication_kind: string;
  content_format: string;
  schedule_mode: string;
  target_account_ids_json: string | null;
  created_at: string;
  updated_at: string;
};

function targetIdsFromJson(value: string | null): string[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Template target snapshot повреждён');
  }
  return [...new Set(parsed)];
}

function templateView(row: TemplateRow): any {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    projectId: row.project_id,
    projectName: row.project_name,
    templateType: row.template_type,
    bodyRich: parseRichTextJson(row.body_rich_json),
    bodyPlain: row.body_plain,
    publicationKind: row.publication_kind,
    contentFormat: row.content_format,
    scheduleMode: row.schedule_mode,
    targetAccountIds: targetIdsFromJson(row.target_account_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requiredString(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new TemplateValidationError(`${field} обязателен`);
  return text;
}

function normalizeTargetIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TemplateValidationError('targetAccountIds должен быть массивом строк или null');
  }
  const accountIds = [...new Set(value.map((item) => String(item)))];
  const exists = db.prepare('SELECT 1 FROM social_accounts WHERE id=?');
  for (const accountId of accountIds) {
    if (!exists.get(accountId)) throw new TemplateValidationError(`Неизвестный account id: ${accountId}`);
  }
  return accountIds;
}

function validateKey(value: unknown): string {
  const key = requiredString(value, 'key');
  if (!TEMPLATE_KEY.test(key)) {
    throw new TemplateValidationError('key: только A-Z, a-z, 0-9, точка, подчёркивание, двоеточие или дефис');
  }
  return key;
}

function enumValue(value: unknown, allowed: Set<string>, field: string): string {
  const result = requiredString(value, field);
  if (!allowed.has(result)) throw new TemplateValidationError(`Неверный ${field}`);
  return result;
}

function templateTypeValue(value: unknown): string {
  return enumValue(value ?? 'POST', TEMPLATE_TYPES, 'templateType');
}

function isReusableBlockType(value: string): boolean {
  return REUSABLE_BLOCK_TYPES.has(value);
}

function requireProject(projectId: string): void {
  if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) {
    throw new TemplateValidationError('Проект не найден');
  }
}

function ensureUniqueKey(key: string, exceptId?: string): void {
  const row = exceptId
    ? db.prepare('SELECT id FROM templates WHERE key=? AND id<>?').get(key, exceptId)
    : db.prepare('SELECT id FROM templates WHERE key=?').get(key);
  if (row) throw new TemplateValidationError('Template key уже используется');
}

export function listTemplates(): any[] {
  const rows = db.prepare(`SELECT t.*,p.name AS project_name
    FROM templates t JOIN projects p ON p.id=t.project_id
    ORDER BY t.updated_at DESC,t.name,t.id`).all() as TemplateRow[];
  return rows.map(templateView);
}

export function getTemplate(templateId: string): any {
  const row = db.prepare(`SELECT t.*,p.name AS project_name
    FROM templates t JOIN projects p ON p.id=t.project_id WHERE t.id=?`)
    .get(templateId) as TemplateRow | undefined;
  if (!row) throw new TemplateNotFoundError('Шаблон не найден');
  return templateView(row);
}

export function createTemplate(input: TemplateMutationInput): any {
  const key = validateKey(input.key);
  const name = requiredString(input.name, 'name');
  const projectId = requiredString(input.projectId, 'projectId');
  requireProject(projectId);
  ensureUniqueKey(key);
  const bodyRichJson = serializeRichText(input.bodyRich);
  const bodyPlain = richTextToPlain(input.bodyRich).trim();
  if (!bodyPlain) throw new TemplateValidationError('Текст шаблона обязателен');
  const templateType = templateTypeValue(input.templateType);
  const reusableBlock = isReusableBlockType(templateType);
  const publicationKind = reusableBlock
    ? 'FEED'
    : enumValue(input.publicationKind ?? 'FEED', PUBLICATION_KINDS, 'publicationKind');
  const contentFormat = reusableBlock
    ? 'TEXT_ONLY'
    : enumValue(input.contentFormat ?? 'IMAGE', CONTENT_FORMATS, 'contentFormat');
  const scheduleMode = reusableBlock
    ? 'MANUAL'
    : enumValue(input.scheduleMode ?? 'MANUAL', SCHEDULE_MODES, 'scheduleMode');
  const targetAccountIds = reusableBlock ? null : normalizeTargetIds(input.targetAccountIds);
  const templateId = id('tpl');
  const now = nowIso();

  db.prepare(`INSERT INTO templates
    (id,key,name,project_id,template_type,body_rich_json,body_plain,publication_kind,
     content_format,schedule_mode,target_account_ids_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      templateId, key, name, projectId, templateType, bodyRichJson, bodyPlain, publicationKind,
      contentFormat, scheduleMode,
      targetAccountIds === null ? null : JSON.stringify(targetAccountIds),
      now, now
    );
  return getTemplate(templateId);
}
export function updateTemplate(templateId: string, input: TemplateMutationInput): any {
  const current = db.prepare('SELECT * FROM templates WHERE id=?').get(templateId) as TemplateRow | undefined;
  if (!current) throw new TemplateNotFoundError('Шаблон не найден');

  if (input.templateType !== undefined) {
    const requestedType = templateTypeValue(input.templateType);
    if (requestedType !== current.template_type) {
      throw new TemplateValidationError('templateType нельзя менять после создания');
    }
  }

  const key = input.key === undefined ? current.key : validateKey(input.key);
  const name = input.name === undefined ? current.name : requiredString(input.name, 'name');
  const projectId = input.projectId === undefined ? current.project_id : requiredString(input.projectId, 'projectId');
  requireProject(projectId);
  ensureUniqueKey(key, templateId);

  let bodyRichJson = current.body_rich_json;
  let bodyPlain = current.body_plain;
  if (input.bodyRich !== undefined) {
    bodyRichJson = serializeRichText(input.bodyRich);
    bodyPlain = richTextToPlain(input.bodyRich).trim();
    if (!bodyPlain) throw new TemplateValidationError('Текст шаблона обязателен');
  }

  const reusableBlock = isReusableBlockType(current.template_type);
  const publicationKind = reusableBlock
    ? 'FEED'
    : input.publicationKind === undefined
      ? current.publication_kind
      : enumValue(input.publicationKind, PUBLICATION_KINDS, 'publicationKind');
  const contentFormat = reusableBlock
    ? 'TEXT_ONLY'
    : input.contentFormat === undefined
      ? current.content_format
      : enumValue(input.contentFormat, CONTENT_FORMATS, 'contentFormat');
  const scheduleMode = reusableBlock
    ? 'MANUAL'
    : input.scheduleMode === undefined
      ? current.schedule_mode
      : enumValue(input.scheduleMode, SCHEDULE_MODES, 'scheduleMode');
  const targetAccountIds = reusableBlock
    ? null
    : input.targetAccountIds === undefined
      ? targetIdsFromJson(current.target_account_ids_json)
      : normalizeTargetIds(input.targetAccountIds);

  db.prepare(`UPDATE templates SET key=?,name=?,project_id=?,body_rich_json=?,body_plain=?,
    publication_kind=?,content_format=?,schedule_mode=?,target_account_ids_json=?,updated_at=?
    WHERE id=?`).run(
      key, name, projectId, bodyRichJson, bodyPlain, publicationKind, contentFormat,
      scheduleMode, targetAccountIds === null ? null : JSON.stringify(targetAccountIds),
      nowIso(), templateId
    );
  return getTemplate(templateId);
}

export function deleteTemplate(templateId: string): void {
  const result = db.prepare('DELETE FROM templates WHERE id=?').run(templateId);
  if (!result.changes) throw new TemplateNotFoundError('Шаблон не найден');
}

type TargetWarning = {
  code: 'TEMPLATE_TARGET_UNAVAILABLE';
  accountId: string;
  reason: 'missing' | 'disabled';
};
function explicitEnabledTargets(accountIds: string[]): { valid: string[]; warnings: TargetWarning[] } {
  const lookup = db.prepare('SELECT id,enabled FROM social_accounts WHERE id=?');
  const valid: string[] = [];
  const warnings: TargetWarning[] = [];
  for (const accountId of accountIds) {
    const row = lookup.get(accountId) as { id: string; enabled: number } | undefined;
    if (!row) warnings.push({ code: 'TEMPLATE_TARGET_UNAVAILABLE', accountId, reason: 'missing' });
    else if (row.enabled !== 1) warnings.push({ code: 'TEMPLATE_TARGET_UNAVAILABLE', accountId, reason: 'disabled' });
    else valid.push(accountId);
  }
  return { valid, warnings };
}

export function createPostFromTemplate(templateId: string): { postId: string; warnings: TargetWarning[] } {
  const row = db.prepare('SELECT * FROM templates WHERE id=?').get(templateId) as TemplateRow | undefined;
  if (!row) throw new TemplateNotFoundError('Шаблон не найден');
  if (row.template_type !== 'POST') throw new TemplateValidationError('Поддерживается только template_type=POST');

  const storedTargets = targetIdsFromJson(row.target_account_ids_json);
  const resolved = storedTargets === null
    ? { valid: undefined, warnings: [] as TargetWarning[] }
    : explicitEnabledTargets(storedTargets);
  const post = createDraftPost({
    projectId: row.project_id,
    title: row.name,
    body: row.body_plain,
    bodyRichJson: row.body_rich_json,
    scheduleMode: row.schedule_mode as 'MANUAL' | 'AT' | 'QUEUE',
    publicationKind: row.publication_kind as 'FEED' | 'SHORT' | 'STORY',
    contentFormat: row.content_format as 'TEXT_ONLY' | 'IMAGE' | 'CAROUSEL' | 'VIDEO' | 'VERTICAL_VIDEO' | 'STORY_SEQUENCE',
    targetAccountIds: resolved.valid,
    actorSource: 'manual'
  });

  event({
    postId: String(post.id),
    type: 'template.applied',
    message: 'Шаблон применён к новой публикации',
    data: {
      postId: String(post.id),
      templateId: row.id,
      templateKey: row.key
    }
  });

  return { postId: String(post.id), warnings: resolved.warnings };
}
