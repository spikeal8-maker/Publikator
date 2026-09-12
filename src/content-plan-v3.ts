import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWriteOnlyWorkbook, loadWorkbookStream } from '@office-kit/xlsx/streaming';
import { fromBuffer, toFile } from '@office-kit/xlsx/node';
import { config } from './config.js';
import { db, event, id, nowIso, type Platform } from './db.js';
import { commitContentEdit } from './content-versioning.js';
import { ensureTargets, setTargetSelection } from './publisher.js';

export const CONTENT_PLAN_V3_VERSION = 3;
export const CONTENT_PLAN_V3_COLUMNS = [
  'schema_version', 'external_id', 'action', 'project', 'template_key', 'internal_title', 'body',
  'publication_kind', 'content_format', 'schedule_mode', 'scheduled_at', 'timezone', 'targets',
  'telegram_body', 'vk_body', 'max_body', 'instagram_body', 'media', 'tags', 'source_note', 'source_revision'
] as const;
export const MAX_CONTENT_PLAN_V3_ROWS = 10_000;
export const MAX_CONTENT_PLAN_V3_BYTES = 20 * 1024 * 1024;

const SOURCE_TYPE = 'content-plan-v3';
const EDITABLE_IMPORT_STATUSES = new Set(['DRAFT', 'READY', 'FAILED']);

type V3Column = typeof CONTENT_PLAN_V3_COLUMNS[number];
type V3Cells = Record<V3Column, string>;
type V3ParsedRow = { rowNumber: number; cells: V3Cells };
type V3Parsed = { format: 'csv' | 'xlsx'; fileSha256: string; rows: V3ParsedRow[] };
export type V3Classification = 'NEW' | 'UPDATE' | 'UNCHANGED' | 'CONFLICT' | 'ARCHIVE_REQUEST' | 'TRASH_REQUEST' | 'ERROR';

type ResolvedAccount = { accountId: string; platform: Platform; name: string };
type V3Action = 'UPSERT' | 'ARCHIVE' | 'TRASH_REQUEST';
type V3Normalized = {
  rowNumber: number;
  externalId: string;
  sourceRevision: string;
  payloadHash: string;
  action: V3Action;
  projectId: string | null;
  project: string;
  title: string;
  body: string;
  scheduleMode: 'MANUAL' | 'AT' | 'QUEUE';
  scheduledAt: string | null;
  targets: ResolvedAccount[];
  overrides: Array<ResolvedAccount & { text: string }>;
  classification: V3Classification;
  postId: string | null;
  importedContentVersion: number | null;
};
export type V3ValidationRow = { rowNumber: number; classification: V3Classification; errors: string[]; normalized: V3Normalized | null };
export type V3Validation = {
  version: 3;
  sourceId: string;
  fileSha256: string;
  format: 'csv' | 'xlsx';
  canApply: boolean;
  summary: { totalRows: number; newRows: number; updateRows: number; unchangedRows: number; conflicts: number; requests: number; errors: number };
  rows: V3ValidationRow[];
};

type ExistingSourcePost = {
  id: string;
  content_version: number;
  imported_content_version: number | null;
  source_revision: string | null;
  source_payload_hash: string | null;
  status: string;
};

function validateSourceId(value: string): string {
  const sourceId = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sourceId)) throw new Error('sourceId: 1-128 chars A-Z a-z 0-9 . _ : -');
  return sourceId;
}

function sourceRef(sourceId: string, externalId: string): string {
  return JSON.stringify([sourceId, externalId]);
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase();
}

function cellString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(cellString).join('');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (record.result !== undefined) return cellString(record.result);
  }
  return String(value);
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) { quoted = true; continue; }
    if (char === delimiter) { row.push(field); field = ''; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = ''; continue;
    }
    field += char;
  }
  if (quoted) throw new Error('CSV is malformed: unclosed quote');
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function matrixRows(matrix: string[][]): V3ParsedRow[] {
  if (!matrix.length) throw new Error('File is empty');
  const header = matrix[0]!.map(normalizedHeader);
  const seen = new Set(header);
  if (seen.size !== header.length) throw new Error('Header contains duplicate columns');
  const missing = CONTENT_PLAN_V3_COLUMNS.filter((column) => !seen.has(column));
  const unknown = header.filter((column) => !CONTENT_PLAN_V3_COLUMNS.includes(column as V3Column));
  if (missing.length || unknown.length) {
    throw new Error(`Schema 3 mismatch: ${missing.length ? `missing ${missing.join(', ')}` : ''}${unknown.length ? `; unknown ${unknown.join(', ')}` : ''}`);
  }
  const indexes = Object.fromEntries(CONTENT_PLAN_V3_COLUMNS.map((column) => [column, header.indexOf(column)])) as Record<V3Column, number>;
  const out: V3ParsedRow[] = [];
  for (let index = 1; index < matrix.length; index += 1) {
    const raw = matrix[index] ?? [];
    if (raw.every((value) => String(value ?? '').trim() === '')) continue;
    const cells = Object.fromEntries(CONTENT_PLAN_V3_COLUMNS.map((column) => [column, String(raw[indexes[column]] ?? '')])) as V3Cells;
    out.push({ rowNumber: index + 1, cells });
    if (out.length > MAX_CONTENT_PLAN_V3_ROWS) throw new Error(`More than ${MAX_CONTENT_PLAN_V3_ROWS} rows`);
  }
  if (!out.length) throw new Error('No data rows');
  return out;
}

async function parseXlsx(buffer: Buffer): Promise<V3ParsedRow[]> {
  const workbook = await loadWorkbookStream(fromBuffer(buffer));
  try {
    const name = workbook.sheetNames[0];
    if (!name) throw new Error('XLSX has no sheets');
    const sheet = workbook.openWorksheet(name);
    const matrix: string[][] = [];
    for await (const row of sheet.iterRows()) {
      matrix.push(row.map((cell: { value: unknown }) => cellString(cell.value)));
      if (matrix.length > MAX_CONTENT_PLAN_V3_ROWS + 1) throw new Error('Too many rows');
    }
    return matrixRows(matrix);
  } finally {
    await workbook.close();
  }
}

export async function parseContentPlanV3(filename: string, buffer: Buffer): Promise<V3Parsed> {
  if (buffer.byteLength < 1) throw new Error('File is empty');
  if (buffer.byteLength > MAX_CONTENT_PLAN_V3_BYTES) throw new Error('File exceeds 20 MB');
  const fileSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) {
    const text = buffer.toString('utf8');
    const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
    const delimiter = [';', ',', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0]!;
    return { format: 'csv', fileSha256, rows: matrixRows(parseDelimited(text, delimiter)) };
  }
  if (lower.endsWith('.xlsx')) return { format: 'xlsx', fileSha256, rows: await parseXlsx(buffer) };
  throw new Error('Only .csv and .xlsx are supported');
}

type AccountRow = { id: string; platform: Platform; name: string; enabled: number };

function parseTargets(value: string, accounts: AccountRow[], errors: string[]): ResolvedAccount[] {
  if (!value.trim()) return [];
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { errors.push('targets: invalid JSON'); return []; }
  if (!Array.isArray(raw)) { errors.push('targets: JSON array required'); return []; }

  const resolved: ResolvedAccount[] = [];
  const selectedIds = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push('targets: object expected'); continue; }
    const record = item as Record<string, unknown>;
    const accountId = String(record.accountId ?? '').trim();
    const platform = String(record.platform ?? '').trim() as Platform;
    const name = String(record.name ?? '').trim();
    let match: AccountRow | undefined;

    if (accountId) {
      match = accounts.find((account) => account.id === accountId);
      if (!match || !match.enabled) { errors.push(`targets: account not found/disabled ${accountId}`); continue; }
      if (platform && match.platform !== platform) { errors.push(`targets: accountId ${accountId} does not match platform=${platform}`); continue; }
      if (name && match.name !== name) { errors.push(`targets: accountId ${accountId} does not match name=${name}`); continue; }
    } else {
      if (!platform || !name) { errors.push('targets: platform + name are required without accountId'); continue; }
      const matches = accounts.filter((account) => account.enabled && account.platform === platform && account.name === name);
      if (matches.length === 0) { errors.push(`targets: account not found/disabled ${platform}/${name}`); continue; }
      if (matches.length > 1) { errors.push(`targets: ambiguous account ${platform}/${name}; specify accountId`); continue; }
      match = matches[0];
    }

    if (!match) continue;
    if (selectedIds.has(match.id)) { errors.push(`targets: duplicate account ${match.id}`); continue; }
    selectedIds.add(match.id);
    resolved.push({ accountId: match.id, platform: match.platform, name: match.name });
  }
  return resolved;
}

function resolveOverrides(cells: V3Cells, targets: ResolvedAccount[], errors: string[]): Array<ResolvedAccount & { text: string }> {
  const overrides: Array<ResolvedAccount & { text: string }> = [];
  const columns: Array<[Platform, 'telegram_body' | 'vk_body' | 'max_body' | 'instagram_body']> = [
    ['telegram', 'telegram_body'], ['vk', 'vk_body'], ['max', 'max_body'], ['instagram', 'instagram_body']
  ];
  for (const [platform, column] of columns) {
    const text = cells[column].trim();
    if (!text) continue;
    const matches = targets.filter((target) => target.platform === platform);
    if (!matches.length) { errors.push(`${column}: no selected ${platform} account`); continue; }
    for (const target of matches) overrides.push({ ...target, text });
  }
  return overrides;
}

function parseSchedule(modeRaw: string, atRaw: string, errors: string[]): { mode: 'MANUAL' | 'AT' | 'QUEUE'; at: string | null } | null {
  const mode = modeRaw.trim().toUpperCase();
  if (!['MANUAL', 'AT', 'QUEUE'].includes(mode)) { errors.push('schedule_mode: MANUAL/AT/QUEUE'); return null; }
  if (mode !== 'AT') {
    if (atRaw.trim()) errors.push('scheduled_at must be empty unless schedule_mode=AT');
    return { mode: mode as 'MANUAL' | 'QUEUE', at: null };
  }
  const date = new Date(atRaw.trim());
  if (!atRaw.trim() || Number.isNaN(date.getTime())) { errors.push('scheduled_at: valid date required for AT'); return null; }
  return { mode: 'AT', at: date.toISOString() };
}

function payloadHash(input: {
  action: V3Action;
  projectId: string | null;
  title: string;
  body: string;
  scheduleMode: 'MANUAL' | 'AT' | 'QUEUE';
  scheduledAt: string | null;
  targets: ResolvedAccount[];
  overrides: Array<ResolvedAccount & { text: string }>;
}): string {
  const canonical = {
    action: input.action,
    projectId: input.projectId,
    title: input.title,
    body: input.body,
    publicationKind: 'FEED',
    contentFormat: 'IMAGE',
    scheduleMode: input.scheduleMode,
    scheduledAt: input.scheduledAt,
    timezone: 'UTC',
    targetAccountIds: input.targets.map((target) => target.accountId).sort(),
    overrides: input.overrides.map((override) => ({ accountId: override.accountId, text: override.text })).sort((a, b) => a.accountId.localeCompare(b.accountId))
  };
  return sha256Text(JSON.stringify(canonical));
}

export async function validateContentPlanV3(parsed: V3Parsed, sourceIdRaw: string): Promise<V3Validation> {
  const sourceId = validateSourceId(sourceIdRaw);
  const projectMap = new Map((db.prepare('SELECT id,slug FROM projects').all() as Array<{ id: string; slug: string }>).map((row) => [row.slug, row.id]));
  const accounts = db.prepare('SELECT id,platform,name,enabled FROM social_accounts').all() as AccountRow[];
  const seenExternal = new Set<string>();
  const rows: V3ValidationRow[] = [];

  for (const row of parsed.rows) {
    const cells = row.cells;
    const errors: string[] = [];
    if (cells.schema_version.trim() !== '3') errors.push('schema_version must be 3');

    const externalId = cells.external_id.trim();
    if (!externalId || externalId.length > 160) errors.push('external_id is required (max 160 chars)');
    if (externalId && seenExternal.has(externalId)) errors.push('external_id is duplicated in file');
    if (externalId) seenExternal.add(externalId);

    const actionRaw = cells.action.trim().toUpperCase();
    const action = actionRaw as V3Action;
    if (!['UPSERT', 'ARCHIVE', 'TRASH_REQUEST'].includes(action)) errors.push('action: UPSERT/ARCHIVE/TRASH_REQUEST');

    const sourceRevision = cells.source_revision.trim();
    if (!sourceRevision) errors.push('source_revision is required');

    let projectId: string | null = null;
    let project = '';
    let title = '';
    let body = '';
    let scheduleMode: 'MANUAL' | 'AT' | 'QUEUE' = 'MANUAL';
    let scheduledAt: string | null = null;
    let targets: ResolvedAccount[] = [];
    let overrides: Array<ResolvedAccount & { text: string }> = [];

    if (action === 'UPSERT') {
      project = cells.project.trim();
      projectId = projectMap.get(project) ?? null;
      if (!projectId) errors.push(`project not found: ${project}`);
      title = cells.internal_title.trim();
      body = cells.body.trim();
      if (!title) errors.push('internal_title is required');
      if (!body) errors.push('body is required');
      if (cells.template_key.trim()) errors.push('template_key is not supported in M0-003');
      if (cells.publication_kind.trim().toUpperCase() !== 'FEED') errors.push('M0-003 supports publication_kind=FEED only');
      if (cells.content_format.trim().toUpperCase() !== 'IMAGE') errors.push('M0-003 foundation supports content_format=IMAGE only');
      if (cells.media.trim()) errors.push('media resolver belongs to a later ingestion/media checkpoint');
      if (cells.tags.trim() || cells.source_note.trim()) errors.push('tags/source_note persistence belongs to a later editorial milestone');
      const timezone = cells.timezone.trim().toUpperCase();
      if (timezone && !['UTC', 'ETC/UTC'].includes(timezone)) errors.push('timezone must be UTC until M0-005');

      const schedule = parseSchedule(cells.schedule_mode, cells.scheduled_at, errors);
      if (schedule) { scheduleMode = schedule.mode; scheduledAt = schedule.at; }
      targets = parseTargets(cells.targets, accounts, errors);
      overrides = resolveOverrides(cells, targets, errors);
    }

    const hash = payloadHash({ action, projectId, title, body, scheduleMode, scheduledAt, targets, overrides });
    const ref = sourceRef(sourceId, externalId);
    const existing = externalId ? db.prepare(`SELECT id,content_version,imported_content_version,source_revision,source_payload_hash,status
      FROM posts WHERE source_type=? AND source_ref=?`).get(SOURCE_TYPE, ref) as ExistingSourcePost | undefined : undefined;

    let classification: V3Classification = 'ERROR';
    let postId: string | null = null;
    let importedContentVersion: number | null = null;

    if (!errors.length) {
      if (!existing) {
        if (action === 'UPSERT') classification = 'NEW';
        else errors.push(`${action}: post for external_id does not exist`);
      } else {
        postId = existing.id;
        importedContentVersion = existing.imported_content_version;
        const payloadUnchanged = existing.source_payload_hash === hash;
        const diverged = existing.imported_content_version === null || existing.content_version !== existing.imported_content_version;

        if (payloadUnchanged) {
          classification = 'UNCHANGED';
        } else if (existing.source_revision === sourceRevision) {
          errors.push('source_revision was reused with a different payload');
        } else if (!EDITABLE_IMPORT_STATUSES.has(existing.status)) {
          errors.push(`Post status=${existing.status} is immutable for schema 3 import`);
        } else if (diverged) {
          classification = 'CONFLICT';
        } else if (action === 'ARCHIVE') {
          classification = 'ARCHIVE_REQUEST';
        } else if (action === 'TRASH_REQUEST') {
          classification = 'TRASH_REQUEST';
        } else {
          classification = 'UPDATE';
        }
      }
    }

    if (errors.length) classification = 'ERROR';
    const normalized = errors.length ? null : {
      rowNumber: row.rowNumber,
      externalId,
      sourceRevision,
      payloadHash: hash,
      action,
      projectId,
      project,
      title,
      body,
      scheduleMode,
      scheduledAt,
      targets,
      overrides,
      classification,
      postId,
      importedContentVersion
    } satisfies V3Normalized;
    rows.push({ rowNumber: row.rowNumber, classification, errors, normalized });
  }

  const count = (kind: V3Classification) => rows.filter((row) => row.classification === kind).length;
  const conflicts = count('CONFLICT');
  const errors = count('ERROR');
  return {
    version: 3,
    sourceId,
    fileSha256: parsed.fileSha256,
    format: parsed.format,
    canApply: errors === 0 && conflicts === 0,
    summary: {
      totalRows: rows.length,
      newRows: count('NEW'),
      updateRows: count('UPDATE'),
      unchangedRows: count('UNCHANGED'),
      conflicts,
      requests: count('ARCHIVE_REQUEST') + count('TRASH_REQUEST'),
      errors
    },
    rows
  };
}

function applyOverrides(postId: string, targets: ResolvedAccount[], overrides: Array<ResolvedAccount & { text: string }>): void {
  ensureTargets(postId);
  setTargetSelection(postId, targets.map((target) => target.accountId));
  db.prepare("UPDATE post_targets SET override_text=NULL WHERE post_id=? AND state!='PUBLISHED'").run(postId);
  const update = db.prepare("UPDATE post_targets SET override_text=?,updated_at=? WHERE post_id=? AND account_id=? AND state!='PUBLISHED'");
  for (const override of overrides) update.run(override.text, nowIso(), postId, override.accountId);
}

export function applyContentPlanV3(validation: V3Validation): { created: number; updated: number; unchanged: number; archived: number; trashed: number; postIds: string[] } {
  if (!validation.canApply) throw new Error('Schema 3 preview contains ERROR/CONFLICT');
  const batch = id('batch');
  const postIds: string[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let archived = 0;
  let trashed = 0;

  const transaction = db.transaction(() => {
    for (const item of validation.rows) {
      const row = item.normalized!;
      const ref = sourceRef(validation.sourceId, row.externalId);
      const now = nowIso();

      if (row.classification === 'UNCHANGED') {
        unchanged += 1;
        if (row.postId) {
          db.prepare(`UPDATE posts SET source_revision=?,source_payload_hash=?,source_batch_id=?,imported_at=? WHERE id=?`)
            .run(row.sourceRevision, row.payloadHash, batch, now, row.postId);
        }
        continue;
      }

      if (row.classification === 'NEW') {
        if (!row.projectId) throw new Error('NEW row lost projectId after preview');
        const postId = id('post');
        postIds.push(postId);
        created += 1;
        db.prepare(`INSERT INTO posts (
          id,project_id,title,body,status,editorial_stage,schedule_mode,scheduled_at,content_version,ready_revision_id,
          source_type,source_ref,source_revision,source_payload_hash,source_batch_id,imported_at,imported_content_version,created_at,updated_at
        ) VALUES (?,?,?,?, 'DRAFT','DRAFT',?,?,1,NULL,?,?,?,?,?,?,1,?,?)`).run(
          postId, row.projectId, row.title, row.body, row.scheduleMode, row.scheduledAt,
          SOURCE_TYPE, ref, row.sourceRevision, row.payloadHash, batch, now, now, now
        );
        applyOverrides(postId, row.targets, row.overrides);
        continue;
      }

      const postId = row.postId!;
      postIds.push(postId);
      if (row.importedContentVersion === null) throw new Error('Import binding is missing imported_content_version');
      const edit = commitContentEdit(postId, row.importedContentVersion, () => {
        if (row.classification === 'UPDATE') {
          if (!row.projectId) throw new Error('UPDATE row lost projectId after preview');
          db.prepare('UPDATE posts SET project_id=?,title=?,body=?,schedule_mode=?,scheduled_at=? WHERE id=?')
            .run(row.projectId, row.title, row.body, row.scheduleMode, row.scheduledAt, postId);
        }
      });

      if (row.classification === 'UPDATE') {
        applyOverrides(postId, row.targets, row.overrides);
        updated += 1;
      } else if (row.classification === 'ARCHIVE_REQUEST') {
        db.prepare("UPDATE posts SET editorial_stage='ARCHIVED' WHERE id=?").run(postId);
        archived += 1;
      } else if (row.classification === 'TRASH_REQUEST') {
        db.prepare("UPDATE posts SET editorial_stage='TRASHED' WHERE id=?").run(postId);
        trashed += 1;
      }

      db.prepare(`UPDATE posts SET source_revision=?,source_payload_hash=?,source_batch_id=?,imported_at=?,imported_content_version=? WHERE id=?`)
        .run(row.sourceRevision, row.payloadHash, batch, now, edit.contentVersion, postId);
    }
  });

  transaction();
  event({
    type: 'content_plan_v3_applied',
    message: `Schema 3 import: ${validation.rows.length} rows`,
    data: { sourceId: validation.sourceId, batch, created, updated, unchanged, archived, trashed }
  });
  return { created, updated, unchanged, archived, trashed, postIds };
}

export async function createContentPlanV3Template(): Promise<Buffer> {
  const temp = path.join(config.dataDir, `.content-plan-v3-${crypto.randomUUID()}.xlsx`);
  try {
    const workbook = await createWriteOnlyWorkbook(toFile(temp));
    const sheet = await workbook.addWorksheet('Posts');
    const widths = [14,24,16,20,20,34,70,18,20,18,28,20,48,60,60,60,60,52,30,40,24];
    CONTENT_PLAN_V3_COLUMNS.forEach((_column, index) => sheet.setColumnWidth(index + 1, widths[index] ?? 24));
    await sheet.appendRow([...CONTENT_PLAN_V3_COLUMNS]);
    await sheet.appendRow(['3','example-001','UPSERT','main','','Example','Text','FEED','IMAGE','MANUAL','','UTC','[]','','','','','','','','rev-1']);
    await sheet.close();
    await workbook.finalize();
    return await fs.readFile(temp);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function exportContentPlanV3(sourceIdRaw: string): Promise<Buffer> {
  const sourceId = validateSourceId(sourceIdRaw);
  const temp = path.join(config.dataDir, `.content-plan-v3-export-${crypto.randomUUID()}.xlsx`);
  try {
    const workbook = await createWriteOnlyWorkbook(toFile(temp));
    const sheet = await workbook.addWorksheet('Posts');
    await sheet.appendRow([...CONTENT_PLAN_V3_COLUMNS]);
    const posts = db.prepare(`SELECT p.*,pr.slug AS project_slug FROM posts p
      JOIN projects pr ON pr.id=p.project_id
      WHERE p.source_type=? AND p.source_ref IS NOT NULL
      ORDER BY p.created_at,p.id`).all(SOURCE_TYPE) as Array<Record<string, unknown>>;

    for (const post of posts) {
      let pair: unknown;
      try { pair = JSON.parse(String(post.source_ref)); } catch { continue; }
      if (!Array.isArray(pair) || pair[0] !== sourceId) continue;
      const externalId = String(pair[1] ?? '');
      const targets = db.prepare(`SELECT pt.enabled,pt.override_text,a.id,a.platform,a.name
        FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
        WHERE pt.post_id=? ORDER BY a.platform,a.name,a.id`).all(String(post.id)) as Array<{
          enabled: number; override_text: string | null; id: string; platform: Platform; name: string;
        }>;
      const selected = targets.filter((target) => target.enabled).map((target) => ({ accountId: target.id, platform: target.platform, name: target.name }));
      const platformBody = (platform: Platform) => {
        const values = targets.filter((target) => target.enabled && target.platform === platform && target.override_text).map((target) => target.override_text!);
        return values.length && values.every((value) => value === values[0]) ? values[0]! : '';
      };
      await sheet.appendRow([
        '3', externalId, 'UPSERT', String(post.project_slug), '', String(post.title), String(post.body),
        'FEED', 'IMAGE', String(post.schedule_mode), post.scheduled_at ? String(post.scheduled_at) : '', 'UTC',
        JSON.stringify(selected), platformBody('telegram'), platformBody('vk'), platformBody('max'), platformBody('instagram'),
        '', '', '', String(post.source_revision ?? '')
      ]);
    }

    await sheet.close();
    await workbook.finalize();
    return await fs.readFile(temp);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}
