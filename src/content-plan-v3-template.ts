import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWriteOnlyWorkbook } from '@office-kit/xlsx/streaming';
import { toFile } from '@office-kit/xlsx/node';
import { config } from './config.js';
import { db } from './db.js';
import { CONTENT_PLAN_V3_COLUMNS } from './content-plan-v3.js';
import { spreadsheetSafeText } from './ingestion-security.js';

const WIDTHS = [14,24,16,20,20,34,70,18,20,18,28,20,48,60,60,60,60,52,30,40,24];

function exampleRows(): string[][] {
  const project = (db.prepare('SELECT slug FROM projects ORDER BY created_at,slug LIMIT 1').get() as { slug: string } | undefined)?.slug ?? 'main';
  const driveSource = (db.prepare("SELECT name FROM ingestion_connectors WHERE enabled=1 AND type='google_drive' ORDER BY created_at,id LIMIT 1").get() as { name: string } | undefined)?.name ?? 'Google Drive source';
  const yandexSource = (db.prepare("SELECT name FROM ingestion_connectors WHERE enabled=1 AND type='yandex_disk' ORDER BY created_at,id LIMIT 1").get() as { name: string } | undefined)?.name ?? 'Yandex Disk source';
  const accounts = db.prepare('SELECT platform,name FROM social_accounts WHERE enabled=1 ORDER BY platform,name,id LIMIT 2').all() as Array<{ platform: string; name: string }>;
  const targets = JSON.stringify(accounts.map((account) => ({ platform: account.platform, name: account.name })));

  return [
    ['3','manual-001','UPSERT',project,'','\u0420\u0443\u0447\u043d\u0430\u044f \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f','\u0422\u0435\u043a\u0441\u0442 \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u0438','FEED','IMAGE','MANUAL','','','[]','','','','','','','','rev-1'],
    ['3','drive-001','UPSERT',project,'','Google Drive \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435','\u041f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u0441 \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435\u043c \u0438\u0437 Google Drive','FEED','IMAGE','MANUAL','','','[]','','','','',JSON.stringify([{ source: driveSource, path: 'lesson-01.jpg' }]),'','','rev-1'],
    ['3','yandex-001','UPSERT',project,'','\u042f\u043d\u0434\u0435\u043a\u0441 \u0414\u0438\u0441\u043a \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435','\u041f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u0441 \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435\u043c \u0438\u0437 \u042f\u043d\u0434\u0435\u043a\u0441 \u0414\u0438\u0441\u043a\u0430','FEED','IMAGE','MANUAL','','','[]','','','','',JSON.stringify([{ source: yandexSource, path: 'september/post-02.jpg' }]),'','','rev-1'],
    ['3','at-001','UPSERT',project,'','\u041f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u043f\u043e \u0432\u0440\u0435\u043c\u0435\u043d\u0438','\u0411\u0443\u0434\u0435\u0442 \u043e\u043f\u0443\u0431\u043b\u0438\u043a\u043e\u0432\u0430\u043d\u0430 \u0432 \u0443\u043a\u0430\u0437\u0430\u043d\u043d\u043e\u0435 \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e\u0435 \u0432\u0440\u0435\u043c\u044f','FEED','IMAGE','AT','2026-09-20 14:00','Europe/Moscow','[]','','','','','','','','rev-1'],
    ['3','queue-001','UPSERT',project,'','\u041f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u0432 \u043e\u0447\u0435\u0440\u0435\u0434\u044c','\u0413\u043e\u0442\u043e\u0432\u044b\u0439 \u043c\u0430\u0442\u0435\u0440\u0438\u0430\u043b \u0434\u043b\u044f \u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u0435\u0441\u043a\u043e\u0439 \u043e\u0447\u0435\u0440\u0435\u0434\u0438','FEED','IMAGE','QUEUE','','','[]','','','','','','','','rev-1'],
    ['3','targets-001','UPSERT',project,'','Selected platforms example','Uses real enabled accounts from the Lists sheet','FEED','IMAGE','MANUAL','','',targets,'','','','','','','','rev-1']
  ];
}

const COLUMN_GUIDE = [
  ['schema_version','always','Версия схемы','3','3'],
  ['external_id','always','Стабильный ID публикации','1-160 chars, unique in source','post-2026-001'],
  ['action','always','Операция','UPSERT / ARCHIVE / TRASH_REQUEST','UPSERT'],
  ['project','UPSERT','slug проекта','existing project slug','main'],
  ['template_key','no','Пока не используется','empty',''],
  ['internal_title','UPSERT','Внутренний заголовок','text','Новый урок'],
  ['body','UPSERT','Основной текст','text','Текст публикации'],
  ['publication_kind','UPSERT','Тип публикации','FEED','FEED'],
  ['content_format','UPSERT','Формат','IMAGE','IMAGE'],
  ['schedule_mode','UPSERT','Режим выпуска','MANUAL / AT / QUEUE','QUEUE'],
  ['scheduled_at','AT only','Дата/время','YYYY-MM-DD HH:MM or ISO','2026-09-20 14:00'],
  ['timezone','AT recommended','IANA timezone','e.g. Europe/Moscow; UTC default','Europe/Moscow'],
  ['targets','optional','Площадки','JSON array of account selectors','[{"platform":"telegram","name":"Основной Telegram"}]'],
  ['telegram_body','optional','Override Telegram','selected Telegram target required',''],
  ['vk_body','optional','Override VK','selected VK target required',''],
  ['max_body','optional','Override MAX','selected MAX target required',''],
  ['instagram_body','optional','Override Instagram','selected Instagram target required',''],
  ['media','Google Sheets only','Cloud image references','JSON [{"source":"connector","path":"relative/file.jpg"}]','Google Drive/Yandex Disk; leave empty for direct XLSX import'],
  ['tags','no','Пока не сохраняется','empty',''],
  ['source_note','no','Пока не сохраняется','empty',''],
  ['source_revision','always','Ревизия исходной строки','change on every semantic edit','rev-1 -> rev-2']
];

function setWidths(sheet: any, widths: number[]): void {
  widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
}

async function appendSafeRows(sheet: any, rows: string[][]): Promise<void> {
  for (const row of rows) await sheet.appendRow(row.map(spreadsheetSafeText));
}

function listRows(): string[][] {
  const projects = db.prepare('SELECT slug FROM projects ORDER BY slug').all() as Array<{ slug: string }>;
  const accounts = db.prepare('SELECT platform,name FROM social_accounts WHERE enabled=1 ORDER BY platform,name').all() as Array<{ platform: string; name: string }>;
  const sources = db.prepare("SELECT type,name FROM ingestion_connectors WHERE enabled=1 AND type IN ('google_drive','yandex_disk') ORDER BY type,name").all() as Array<{ type: string; name: string }>;
  const max = Math.max(projects.length, accounts.length, sources.length, 3);
  const rows: string[][] = [];
  for (let index = 0; index < max; index += 1) {
    rows.push([
      projects[index]?.slug ?? '',
      accounts[index]?.platform ?? '',
      accounts[index]?.name ?? '',
      sources[index]?.name ?? '',
      sources[index]?.type ?? '',
      ['FEED'][index] ?? '',
      ['IMAGE'][index] ?? '',
      ['MANUAL','AT','QUEUE'][index] ?? '',
      ['UPSERT','ARCHIVE','TRASH_REQUEST'][index] ?? '',
      ''
    ]);
  }
  return rows;
}

const INSTRUCTION_ROWS = [
  ['workflow','1','Заполняйте только лист Posts; Lists, Instructions и Examples — справочные.','',''],
  ['workflow','2','external_id должен быть стабильным; source_revision меняйте при каждом смысловом изменении.','',''],
  ['workflow','3','Сначала Preview, потом Apply; Preview не меняет канонические данные.','',''],
  ['workflow','4','media заполняется только в Google Sheets для Google Drive/Яндекс Диск; прямой XLSX import оставляет media пустым.','',''],
  ['workflow','5','MANUAL = ручно; AT = точное время; QUEUE = автоматическая очередь.','',''],
  ['workflow','6','При включённом Google Sheets write-back Publikator заполняет служебные колонки V:AD; не используйте их как входные данные.','V:Y = импорт; Z:AD = результат публикации','']
];

export async function createCanonicalContentPlanV3Template(): Promise<Buffer> {
  const temp = path.join(config.dataDir, `.content-plan-v3-template-${crypto.randomUUID()}.xlsx`);
  try {
    const workbook = await createWriteOnlyWorkbook(toFile(temp));

    const posts = await workbook.addWorksheet('Posts');
    setWidths(posts, WIDTHS);
    await posts.appendRow([...CONTENT_PLAN_V3_COLUMNS]);
    await posts.close();

    const lists = await workbook.addWorksheet('Lists');
    setWidths(lists, [24,20,34,34,20,20,20,22,24,24]);
    await lists.appendRow(['project_slug','account_platform','account_name','cloud_media_source','cloud_media_provider','publication_kind','content_format','schedule_mode','action','template_key']);
    await appendSafeRows(lists, listRows());
    await lists.close();

    const instructions = await workbook.addWorksheet('Instructions');
    setWidths(instructions, [18,24,70,42,70]);
    await instructions.appendRow(['section','name_or_step','guidance','allowed_or_format','example_or_note']);
    await appendSafeRows(instructions, INSTRUCTION_ROWS);
    await appendSafeRows(instructions, COLUMN_GUIDE.map((row) => ['column', ...row]));
    await instructions.close();

    const examples = await workbook.addWorksheet('Examples');
    setWidths(examples, WIDTHS);
    await examples.appendRow([...CONTENT_PLAN_V3_COLUMNS]);
    await appendSafeRows(examples, exampleRows());
    await examples.close();

    await workbook.finalize();
    return await fs.readFile(temp);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}
