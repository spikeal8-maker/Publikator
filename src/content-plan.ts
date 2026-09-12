import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWriteOnlyWorkbook, loadWorkbookStream } from '@office-kit/xlsx/streaming';
import { fromBuffer, toFile } from '@office-kit/xlsx/node';
import { config } from './config.js';
import { db, event, id, nowIso, type Platform } from './db.js';
import { ensureTargets, setTargetSelection } from './publisher.js';
import { safeMediaRelativePath, sha256File } from './backup-format.js';
import type { MediaRow } from './media.js';
import { spreadsheetSafeText } from './ingestion-security.js';

export const CONTENT_PLAN_VERSION = 1;
export const CONTENT_PLAN_COLUMNS = [
  'project',
  'title',
  'body',
  'schedule_mode',
  'scheduled_at',
  'targets',
  'platform_overrides',
  'media_references'
] as const;

export const MAX_CONTENT_PLAN_ROWS = 10_000;
export const MAX_CONTENT_PLAN_BYTES = 20 * 1024 * 1024;
const MAX_OVERRIDE_LENGTH = 20_000;
const PLATFORMS = new Set<Platform>(['telegram', 'vk', 'max', 'instagram']);

type ContentPlanColumn = typeof CONTENT_PLAN_COLUMNS[number];

type AccountRow = {
  id: string;
  platform: Platform;
  name: string;
  enabled: number;
};

export type ContentPlanAccountRef = {
  platform: Platform;
  name: string;
  accountId?: string;
};

export type ContentPlanOverrideRef = ContentPlanAccountRef & {
  text: string;
};

export type ContentPlanMediaRef = {
  relativePath: string;
  originalName?: string;
  sha256?: string;
};

export type ContentPlanExportRow = Record<ContentPlanColumn, string>;

export type ParsedContentPlanRow = {
  rowNumber: number;
  cells: ContentPlanExportRow;
};

export type ParsedContentPlan = {
  format: 'csv' | 'xlsx';
  fileSha256: string;
  rows: ParsedContentPlanRow[];
};

export type ContentPlanIssue = {
  level: 'error' | 'warning';
  column: ContentPlanColumn | 'row';
  message: string;
};

export type ResolvedContentPlanAccount = {
  accountId: string;
  platform: Platform;
  name: string;
  enabled: boolean;
};

export type ResolvedContentPlanMedia = {
  sourceMediaId: string;
  relativePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
};

export type NormalizedContentPlanRow = {
  rowNumber: number;
  projectId: string;
  project: string;
  title: string;
  body: string;
  scheduleMode: 'MANUAL' | 'AT' | 'QUEUE';
  scheduledAt: string | null;
  targets: ResolvedContentPlanAccount[];
  overrides: Array<ResolvedContentPlanAccount & { text: string }>;
  media: ResolvedContentPlanMedia[];
};

export type ContentPlanValidationRow = {
  rowNumber: number;
  valid: boolean;
  issues: ContentPlanIssue[];
  normalized: NormalizedContentPlanRow | null;
};

export type ContentPlanValidation = {
  version: number;
  format: 'csv' | 'xlsx';
  fileSha256: string;
  canApply: boolean;
  summary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    warnings: number;
  };
  rows: ContentPlanValidationRow[];
};

function csvCell(value: string): string {
  if (!/[;"\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function serializeContentPlanCsv(rows: ContentPlanExportRow[]): string {
  const lines = [
    CONTENT_PLAN_COLUMNS.map(csvCell).join(';'),
    ...rows.map((row) => CONTENT_PLAN_COLUMNS.map((column) => csvCell(spreadsheetSafeText(row[column]))).join(';'))
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function firstLogicalLine(text: string): string {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        index += 1;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted && (char === '\n' || char === '\r')) return text.slice(0, index);
  }
  return text;
}

function delimiterCount(line: string, delimiter: string): number {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === delimiter) count += 1;
  }
  return count;
}

function detectDelimiter(text: string): string {
  const header = firstLogicalLine(text.replace(/^\uFEFF/, ''));
  const candidates = [';', ',', '\t'];
  const scored = candidates.map((delimiter) => ({ delimiter, count: delimiterCount(header, delimiter) }));
  scored.sort((a, b) => b.count - a.count);
  if (!scored[0] || scored[0].count < CONTENT_PLAN_COLUMNS.length - 1) {
    throw new Error('Не удалось определить разделитель CSV. Ожидаются ; , или tab и полный заголовок схемы.');
  }
  return scored[0].delimiter;
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
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > MAX_CONTENT_PLAN_ROWS + 1) throw new Error(`Контент-план содержит больше ${MAX_CONTENT_PLAN_ROWS} строк`);
      continue;
    }
    field += char;
  }

  if (quoted) throw new Error('CSV повреждён: незакрытое поле в кавычках');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase();
}

function rowsFromMatrix(matrix: string[][]): ParsedContentPlanRow[] {
  if (matrix.length < 1) throw new Error('Файл контент-плана пустой');
  const header = matrix[0]!.map(normalizedHeader);
  const seen = new Set<string>();
  for (const column of header) {
    if (!column) throw new Error('Заголовок контент-плана содержит пустую колонку');
    if (seen.has(column)) throw new Error(`Заголовок содержит повторяющуюся колонку ${column}`);
    seen.add(column);
  }
  const missing = CONTENT_PLAN_COLUMNS.filter((column) => !seen.has(column));
  const unknown = header.filter((column) => !CONTENT_PLAN_COLUMNS.includes(column as ContentPlanColumn));
  if (missing.length || unknown.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`нет колонок: ${missing.join(', ')}`);
    if (unknown.length) parts.push(`неизвестные колонки: ${unknown.join(', ')}`);
    throw new Error(`Схема контент-плана не совпадает: ${parts.join('; ')}`);
  }

  const indexes = Object.fromEntries(CONTENT_PLAN_COLUMNS.map((column) => [column, header.indexOf(column)])) as Record<ContentPlanColumn, number>;
  const result: ParsedContentPlanRow[] = [];
  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const raw = matrix[rowIndex] ?? [];
    if (raw.every((value) => String(value ?? '').trim() === '')) continue;
    const cells = Object.fromEntries(CONTENT_PLAN_COLUMNS.map((column) => [column, String(raw[indexes[column]] ?? '')])) as ContentPlanExportRow;
    result.push({ rowNumber: rowIndex + 1, cells });
    if (result.length > MAX_CONTENT_PLAN_ROWS) throw new Error(`Контент-план содержит больше ${MAX_CONTENT_PLAN_ROWS} строк`);
  }
  if (result.length < 1) throw new Error('Контент-план не содержит строк данных');
  return result;
}

function cellValueToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(cellValueToString).join('');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (Array.isArray(record.richText)) return record.richText.map(cellValueToString).join('');
    if (record.result !== undefined) return cellValueToString(record.result);
    if (record.value !== undefined && record.value !== value) return cellValueToString(record.value);
  }
  return String(value);
}

async function parseXlsx(buffer: Buffer): Promise<ParsedContentPlanRow[]> {
  const workbook = await loadWorkbookStream(fromBuffer(buffer));
  try {
    const sheetName = workbook.sheetNames[0];
    if (!sheetName) throw new Error('XLSX не содержит листов');
    const sheet = workbook.openWorksheet(sheetName);
    const matrix: string[][] = [];
    for await (const row of sheet.iterRows()) {
      matrix.push(row.map((cell: { value: unknown }) => cellValueToString(cell.value)));
      if (matrix.length > MAX_CONTENT_PLAN_ROWS + 1) throw new Error(`Контент-план содержит больше ${MAX_CONTENT_PLAN_ROWS} строк`);
    }
    return rowsFromMatrix(matrix);
  } finally {
    await workbook.close();
  }
}

export async function parseContentPlanFile(filename: string, buffer: Buffer): Promise<ParsedContentPlan> {
  if (buffer.byteLength < 1) throw new Error('Файл контент-плана пустой');
  if (buffer.byteLength > MAX_CONTENT_PLAN_BYTES) throw new Error('Файл контент-плана больше 20 МБ');
  const lower = filename.toLowerCase();
  const fileSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (lower.endsWith('.csv')) {
    const text = buffer.toString('utf8');
    const delimiter = detectDelimiter(text);
    return { format: 'csv', fileSha256, rows: rowsFromMatrix(parseDelimited(text, delimiter)) };
  }
  if (lower.endsWith('.xlsx')) {
    return { format: 'xlsx', fileSha256, rows: await parseXlsx(buffer) };
  }
  throw new Error('Поддерживаются только .csv и .xlsx');
}

function parseJsonArray<T>(value: string, column: ContentPlanColumn, issues: ContentPlanIssue[]): T[] {
  if (!value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error('ожидается JSON-массив');
    return parsed as T[];
  } catch (error) {
    issues.push({ level: 'error', column, message: `Некорректный JSON: ${error instanceof Error ? error.message : String(error)}` });
    return [];
  }
}

function parseAccountRef(raw: unknown, column: ContentPlanColumn, issues: ContentPlanIssue[]): ContentPlanAccountRef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ level: 'error', column, message: 'Каждая ссылка на аккаунт должна быть JSON-объектом' });
    return null;
  }
  const record = raw as Record<string, unknown>;
  const platform = String(record.platform ?? '').trim().toLowerCase() as Platform;
  const name = String(record.name ?? '').trim();
  const accountId = record.accountId === undefined || record.accountId === null ? undefined : String(record.accountId).trim();
  if (!PLATFORMS.has(platform)) {
    issues.push({ level: 'error', column, message: `Неизвестная platform: ${platform || '(пусто)'}` });
    return null;
  }
  if (!name && !accountId) {
    issues.push({ level: 'error', column, message: 'Для аккаунта нужен name или accountId' });
    return null;
  }
  return { platform, name, ...(accountId ? { accountId } : {}) };
}

function resolveAccount(ref: ContentPlanAccountRef, accounts: AccountRow[], column: ContentPlanColumn, issues: ContentPlanIssue[]): AccountRow | null {
  if (ref.accountId) {
    const byId = accounts.find((account) => account.id === ref.accountId);
    if (byId) {
      if (byId.platform !== ref.platform || (ref.name && byId.name !== ref.name)) {
        issues.push({ level: 'error', column, message: `accountId ${ref.accountId} не совпадает с указанными platform/name` });
        return null;
      }
      return byId;
    }
  }
  const matches = accounts.filter((account) => account.platform === ref.platform && account.name === ref.name);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    issues.push({ level: 'error', column, message: `Аккаунт не найден: ${ref.platform} / ${ref.name || ref.accountId || ''}` });
  } else {
    issues.push({ level: 'error', column, message: `Аккаунт неоднозначен: ${ref.platform} / ${ref.name}; используйте accountId` });
  }
  return null;
}

function parseScheduledAt(mode: string, value: string, issues: ContentPlanIssue[]): { mode: 'MANUAL' | 'AT' | 'QUEUE'; scheduledAt: string | null } | null {
  const normalizedMode = mode.trim().toUpperCase();
  if (!['MANUAL', 'AT', 'QUEUE'].includes(normalizedMode)) {
    issues.push({ level: 'error', column: 'schedule_mode', message: 'Допустимы MANUAL, AT или QUEUE' });
    return null;
  }
  if (normalizedMode !== 'AT') {
    if (value.trim()) issues.push({ level: 'error', column: 'scheduled_at', message: 'scheduled_at должен быть пустым вне режима AT' });
    return { mode: normalizedMode as 'MANUAL' | 'QUEUE', scheduledAt: null };
  }
  if (!value.trim()) {
    issues.push({ level: 'error', column: 'scheduled_at', message: 'Для режима AT требуется scheduled_at' });
    return null;
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    issues.push({ level: 'error', column: 'scheduled_at', message: 'Некорректная дата/время' });
    return null;
  }
  return { mode: 'AT', scheduledAt: parsed.toISOString() };
}

async function verifyMediaSource(media: MediaRow, hashCache: Map<string, string>): Promise<string> {
  const relativePath = safeMediaRelativePath(media.relative_path);
  const absolutePath = path.join(config.mediaDir, ...relativePath.split('/'));
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Файл media отсутствует: ${relativePath}`);
  if (stat.size !== Number(media.size_bytes)) throw new Error(`Размер media не совпадает с БД: ${relativePath}`);
  let hash = hashCache.get(relativePath);
  if (!hash) {
    hash = await sha256File(absolutePath);
    hashCache.set(relativePath, hash);
  }
  if (hash !== media.sha256) throw new Error(`SHA-256 media не совпадает с БД: ${relativePath}`);
  return hash;
}

export async function validateContentPlan(parsed: ParsedContentPlan): Promise<ContentPlanValidation> {
  const accounts = db.prepare('SELECT id,platform,name,enabled FROM social_accounts ORDER BY platform,name,id').all() as AccountRow[];
  const projectBySlug = new Map((db.prepare('SELECT id,slug FROM projects').all() as Array<{ id: string; slug: string }>).map((row) => [row.slug, row.id]));
  const mediaByPath = new Map((db.prepare('SELECT * FROM media').all() as MediaRow[]).map((row) => [safeMediaRelativePath(row.relative_path), row]));
  const hashCache = new Map<string, string>();
  const rows: ContentPlanValidationRow[] = [];

  for (const row of parsed.rows) {
    const issues: ContentPlanIssue[] = [];
    const project = row.cells.project.trim();
    const projectId = projectBySlug.get(project) ?? null;
    if (!project) issues.push({ level: 'error', column: 'project', message: 'project обязателен и должен содержать slug проекта' });
    else if (!projectId) issues.push({ level: 'error', column: 'project', message: `Проект со slug ${project} не найден` });

    const title = row.cells.title.trim();
    const body = row.cells.body.trim();
    if (!title) issues.push({ level: 'error', column: 'title', message: 'Заголовок обязателен' });
    if (!body) issues.push({ level: 'error', column: 'body', message: 'Текст обязателен' });

    const schedule = parseScheduledAt(row.cells.schedule_mode, row.cells.scheduled_at, issues);

    const rawTargets = parseJsonArray<unknown>(row.cells.targets, 'targets', issues);
    const targets: ResolvedContentPlanAccount[] = [];
    const selectedIds = new Set<string>();
    for (const raw of rawTargets) {
      const ref = parseAccountRef(raw, 'targets', issues);
      if (!ref) continue;
      const account = resolveAccount(ref, accounts, 'targets', issues);
      if (!account) continue;
      if (!account.enabled) {
        issues.push({ level: 'error', column: 'targets', message: `Аккаунт отключён и не может быть выбран: ${account.platform} / ${account.name}` });
        continue;
      }
      if (selectedIds.has(account.id)) {
        issues.push({ level: 'error', column: 'targets', message: `Аккаунт указан повторно: ${account.platform} / ${account.name}` });
        continue;
      }
      selectedIds.add(account.id);
      targets.push({ accountId: account.id, platform: account.platform, name: account.name, enabled: true });
    }

    const rawOverrides = parseJsonArray<unknown>(row.cells.platform_overrides, 'platform_overrides', issues);
    const overrides: Array<ResolvedContentPlanAccount & { text: string }> = [];
    const overrideIds = new Set<string>();
    for (const raw of rawOverrides) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push({ level: 'error', column: 'platform_overrides', message: 'Каждый override должен быть JSON-объектом' });
        continue;
      }
      const record = raw as Record<string, unknown>;
      const ref = parseAccountRef(record, 'platform_overrides', issues);
      if (!ref) continue;
      const account = resolveAccount(ref, accounts, 'platform_overrides', issues);
      if (!account) continue;
      const text = typeof record.text === 'string' ? record.text.trim() : '';
      if (!text) {
        issues.push({ level: 'error', column: 'platform_overrides', message: `Пустой override для ${account.platform} / ${account.name}` });
        continue;
      }
      if (text.length > MAX_OVERRIDE_LENGTH) {
        issues.push({ level: 'error', column: 'platform_overrides', message: `Override длиннее ${MAX_OVERRIDE_LENGTH} символов для ${account.platform} / ${account.name}` });
        continue;
      }
      if (overrideIds.has(account.id)) {
        issues.push({ level: 'error', column: 'platform_overrides', message: `Override указан повторно: ${account.platform} / ${account.name}` });
        continue;
      }
      overrideIds.add(account.id);
      if (!selectedIds.has(account.id)) {
        issues.push({ level: 'warning', column: 'platform_overrides', message: `Override для невыбранной цели сохранится, но цель останется выключенной: ${account.platform} / ${account.name}` });
      }
      overrides.push({ accountId: account.id, platform: account.platform, name: account.name, enabled: selectedIds.has(account.id), text });
    }

    const rawMedia = parseJsonArray<unknown>(row.cells.media_references, 'media_references', issues);
    const media: ResolvedContentPlanMedia[] = [];
    const mediaPaths = new Set<string>();
    for (const raw of rawMedia) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push({ level: 'error', column: 'media_references', message: 'Каждая media reference должна быть JSON-объектом' });
        continue;
      }
      const record = raw as Record<string, unknown>;
      let relativePath: string;
      try {
        relativePath = safeMediaRelativePath(String(record.relativePath ?? ''));
      } catch (error) {
        issues.push({ level: 'error', column: 'media_references', message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (mediaPaths.has(relativePath)) {
        issues.push({ level: 'error', column: 'media_references', message: `Media указана повторно: ${relativePath}` });
        continue;
      }
      mediaPaths.add(relativePath);
      const source = mediaByPath.get(relativePath);
      if (!source) {
        issues.push({ level: 'error', column: 'media_references', message: `Media reference не найдена в текущей БД: ${relativePath}` });
        continue;
      }
      const expectedHash = record.sha256 === undefined || record.sha256 === null || String(record.sha256).trim() === '' ? null : String(record.sha256).trim().toLowerCase();
      if (expectedHash && expectedHash !== source.sha256) {
        issues.push({ level: 'error', column: 'media_references', message: `SHA-256 из файла не совпадает с БД: ${relativePath}` });
        continue;
      }
      try {
        await verifyMediaSource(source, hashCache);
      } catch (error) {
        issues.push({ level: 'error', column: 'media_references', message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      media.push({
        sourceMediaId: source.id,
        relativePath,
        originalName: source.original_name,
        mimeType: source.mime_type,
        sizeBytes: source.size_bytes,
        width: source.width,
        height: source.height,
        sha256: source.sha256
      });
    }

    const valid = !issues.some((issue) => issue.level === 'error');
    rows.push({
      rowNumber: row.rowNumber,
      valid,
      issues,
      normalized: valid && projectId && schedule ? {
        rowNumber: row.rowNumber,
        projectId,
        project,
        title,
        body,
        scheduleMode: schedule.mode,
        scheduledAt: schedule.scheduledAt,
        targets,
        overrides,
        media
      } : null
    });
  }

  const invalidRows = rows.filter((row) => !row.valid).length;
  return {
    version: CONTENT_PLAN_VERSION,
    format: parsed.format,
    fileSha256: parsed.fileSha256,
    canApply: invalidRows === 0 && rows.length > 0,
    summary: {
      totalRows: rows.length,
      validRows: rows.length - invalidRows,
      invalidRows,
      warnings: rows.reduce((count, row) => count + row.issues.filter((issue) => issue.level === 'warning').length, 0)
    },
    rows
  };
}

function accountRef(account: { id: string; platform: Platform; name: string }): ContentPlanAccountRef {
  return { platform: account.platform, name: account.name, accountId: account.id };
}

export function exportContentPlanRows(projectId?: string): ContentPlanExportRow[] {
  const values: unknown[] = [];
  const where = projectId ? 'WHERE p.project_id=?' : '';
  if (projectId) values.push(projectId);
  const posts = db.prepare(`SELECT p.*,pr.slug AS project_slug FROM posts p JOIN projects pr ON pr.id=p.project_id ${where} ORDER BY p.created_at,p.id`).all(...values) as Array<Record<string, unknown>>;
  const targetQuery = db.prepare(`SELECT pt.enabled,pt.override_text,a.id,a.platform,a.name
    FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.post_id=? ORDER BY a.platform,a.name,a.id`);
  const mediaQuery = db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order,created_at,id');

  return posts.map((post) => {
    const targets = targetQuery.all(String(post.id)) as Array<{ enabled: number; override_text: string | null; id: string; platform: Platform; name: string }>;
    const selected = targets.filter((target) => target.enabled).map(accountRef);
    const overrides = targets.filter((target) => target.override_text !== null && target.override_text !== '').map((target) => ({ ...accountRef(target), text: target.override_text! }));
    const media = (mediaQuery.all(String(post.id)) as MediaRow[]).map((item) => ({ relativePath: item.relative_path, originalName: item.original_name, sha256: item.sha256 }));
    return {
      project: String(post.project_slug),
      title: String(post.title),
      body: String(post.body),
      schedule_mode: String(post.schedule_mode),
      scheduled_at: post.schedule_mode === 'AT' && post.scheduled_at ? String(post.scheduled_at) : '',
      targets: JSON.stringify(selected),
      platform_overrides: JSON.stringify(overrides),
      media_references: JSON.stringify(media)
    };
  });
}

export async function createContentPlanXlsx(rows: ContentPlanExportRow[]): Promise<Buffer> {
  const tempPath = path.join(config.dataDir, `.content-plan-${crypto.randomUUID()}.xlsx`);
  try {
    const workbook = await createWriteOnlyWorkbook(toFile(tempPath));
    const sheet = await workbook.addWorksheet('Content plan');
    const widths = [18, 34, 70, 16, 28, 48, 56, 56];
    widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
    await sheet.appendRow([...CONTENT_PLAN_COLUMNS]);
    for (const row of rows) {
      await sheet.appendRow(CONTENT_PLAN_COLUMNS.map((column) => spreadsheetSafeText(row[column])));
    }
    await sheet.close();
    await workbook.finalize();
    return await fs.readFile(tempPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function cloneMedia(postId: string, source: ResolvedContentPlanMedia, order: number): Promise<void> {
  const sourceRelativePath = safeMediaRelativePath(source.relativePath);
  const sourcePath = path.join(config.mediaDir, ...sourceRelativePath.split('/'));
  const actualHash = await sha256File(sourcePath);
  if (actualHash !== source.sha256) throw new Error(`Media изменилась после preview: ${source.relativePath}`);

  const mediaId = id('med');
  const sourceExt = path.posix.extname(sourceRelativePath).toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(sourceExt) ? sourceExt : '.bin';
  const relativePath = path.posix.join(postId, `${mediaId}${safeExt}`);
  const destination = path.join(config.mediaDir, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(sourcePath, destination);
  try {
    const stat = await fs.stat(destination);
    if (stat.size !== source.sizeBytes) throw new Error(`Размер скопированной media не совпадает: ${source.relativePath}`);
    const copiedHash = await sha256File(destination);
    if (copiedHash !== source.sha256) throw new Error(`SHA-256 скопированной media не совпадает: ${source.relativePath}`);
    db.prepare(`INSERT INTO media
      (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(mediaId, postId, source.originalName, relativePath, source.mimeType, source.sizeBytes, source.width, source.height, source.sha256, nowIso(), order);
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

function ensureOverrideTarget(postId: string, account: ResolvedContentPlanAccount): void {
  const exists = db.prepare('SELECT id FROM post_targets WHERE post_id=? AND account_id=?').get(postId, account.accountId) as { id: string } | undefined;
  if (exists) return;
  db.prepare(`INSERT INTO post_targets
    (id,post_id,account_id,enabled,state,attempts,updated_at) VALUES (?,?,?,?, 'PENDING',0,?)`)
    .run(id('pt'), postId, account.accountId, account.enabled ? 1 : 0, nowIso());
}

export async function applyValidatedContentPlan(validation: ContentPlanValidation): Promise<{ createdCount: number; postIds: string[] }> {
  if (!validation.canApply) throw new Error('Контент-план содержит ошибки и не может быть применён');
  const normalized = validation.rows.map((row) => row.normalized).filter((row): row is NormalizedContentPlanRow => row !== null);
  const createdPostIds: string[] = [];
  try {
    for (const row of normalized) {
      const postId = id('post');
      createdPostIds.push(postId);
      const now = nowIso();
      db.prepare(`INSERT INTO posts
        (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at)
        VALUES (?,?,?,?, 'DRAFT',?,?,?,?)`)
        .run(postId, row.projectId, row.title, row.body, row.scheduleMode, row.scheduledAt, now, now);

      ensureTargets(postId);
      setTargetSelection(postId, row.targets.map((target) => target.accountId));
      for (const override of row.overrides) {
        ensureOverrideTarget(postId, override);
        db.prepare('UPDATE post_targets SET override_text=?,updated_at=? WHERE post_id=? AND account_id=?')
          .run(override.text, nowIso(), postId, override.accountId);
      }
      for (let index = 0; index < row.media.length; index += 1) {
        await cloneMedia(postId, row.media[index]!, index);
      }
    }

    event({
      type: 'content_plan_imported',
      message: `Импортирован контент-план: ${createdPostIds.length} публикаций`,
      data: { count: createdPostIds.length, fileSha256: validation.fileSha256, format: validation.format }
    });
    return { createdCount: createdPostIds.length, postIds: createdPostIds };
  } catch (error) {
    if (createdPostIds.length > 0) {
      const removePosts = db.transaction(() => {
        const statement = db.prepare('DELETE FROM posts WHERE id=?');
        for (const postId of createdPostIds) statement.run(postId);
      });
      removePosts();
      for (const postId of createdPostIds) {
        await fs.rm(path.join(config.mediaDir, postId), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    throw error;
  }
}
