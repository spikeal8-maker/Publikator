import { db, event, id, nowIso, type Platform } from './db.js';
import { ensureTargets, setTargetSelection, type TargetSelection } from './publisher.js';

const VALID_MODES = new Set(['MANUAL', 'AT', 'QUEUE']);
const VALID_PLATFORMS = new Set<Platform>(['telegram', 'vk', 'max', 'instagram']);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (quoted) throw new Error('CSV содержит незакрытую кавычку');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/^\uFEFF/, '');
}

function platformList(value: string | undefined): Platform[] | null {
  if (!value?.trim()) return null;
  const result = value
    .split(/[;|]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const invalid = result.filter((item) => !VALID_PLATFORMS.has(item as Platform));
  if (invalid.length) throw new Error(`Неизвестные площадки: ${invalid.join(', ')}`);
  return [...new Set(result)] as Platform[];
}

export type CsvImportResult = {
  created: number;
  errors: Array<{ row: number; error: string }>;
  postIds: string[];
};

export function importCsvPosts(projectId: string, csv: string): CsvImportResult {
  if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new Error('Проект не найден');
  if (!csv.trim()) throw new Error('CSV пуст');
  if (Buffer.byteLength(csv, 'utf8') > 2 * 1024 * 1024) throw new Error('CSV больше 2 МБ');

  const rows = parseCsv(csv).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length < 2) throw new Error('CSV должен содержать заголовок и минимум одну строку данных');
  if (rows.length > 1001) throw new Error('За один импорт допускается не более 1000 публикаций');

  const headers = rows[0]!.map(normalizeHeader);
  const index = new Map(headers.map((header, idx) => [header, idx]));
  for (const required of ['title', 'body']) {
    if (!index.has(required)) throw new Error(`В CSV отсутствует обязательная колонка ${required}`);
  }

  const activeAccounts = db.prepare('SELECT id,platform FROM social_accounts WHERE enabled=1 ORDER BY created_at').all() as Array<{ id: string; platform: Platform }>;
  const result: CsvImportResult = { created: 0, errors: [], postIds: [] };

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const get = (name: string): string => {
      const idx = index.get(name);
      return idx === undefined ? '' : String(row[idx] ?? '').trim();
    };

    try {
      const title = get('title');
      const body = get('body');
      if (!title || !body) throw new Error('title и body обязательны');

      const mode = (get('schedule_mode') || 'MANUAL').toUpperCase();
      if (!VALID_MODES.has(mode)) throw new Error(`Неверный schedule_mode: ${mode}`);

      let scheduledAt: string | null = null;
      const scheduledRaw = get('scheduled_at');
      if (mode === 'AT') {
        if (!scheduledRaw) throw new Error('Для schedule_mode=AT требуется scheduled_at');
        const parsed = new Date(scheduledRaw);
        if (Number.isNaN(parsed.getTime())) throw new Error(`Неверная дата scheduled_at: ${scheduledRaw}`);
        scheduledAt = parsed.toISOString();
      }

      const requestedPlatforms = platformList(get('platforms'));
      const postId = id('post');
      const now = nowIso();
      db.prepare('INSERT INTO posts (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(postId, projectId, title, body, 'DRAFT', mode, scheduledAt, now, now);
      ensureTargets(postId);

      if (requestedPlatforms) {
        const selections: TargetSelection[] = activeAccounts
          .filter((account) => requestedPlatforms.includes(account.platform))
          .map((account) => ({
            accountId: account.id,
            overrideText: get(`${account.platform}_text`) || null
          }));
        setTargetSelection(postId, selections);
      } else {
        const selections: TargetSelection[] = activeAccounts.map((account) => ({
          accountId: account.id,
          overrideText: get(`${account.platform}_text`) || null
        }));
        setTargetSelection(postId, selections);
      }

      event({ postId, type: 'post_imported', message: `Пост импортирован из CSV: ${title}` });
      result.created += 1;
      result.postIds.push(postId);
    } catch (error) {
      result.errors.push({ row: rowIndex + 1, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}
