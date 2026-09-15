import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWriteOnlyWorkbook } from '@office-kit/xlsx/streaming';
import { toFile } from '@office-kit/xlsx/node';
import { config } from './config.js';
import { CONTENT_PLAN_V3_COLUMNS } from './content-plan-v3.js';
import { spreadsheetSafeText } from './ingestion-security.js';

const WIDTHS = [14,24,16,20,20,34,70,18,20,18,28,20,48,60,60,60,60,52,30,40,24];

const EXAMPLE_ROWS = [
  ['3','manual-001','UPSERT','main','','\u0420\u0443\u0447\u043d\u0430\u044f \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f','\u0422\u0435\u043a\u0441\u0442 \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u0438','FEED','IMAGE','MANUAL','','','[]','','','','','','','','rev-1'],
  ['3','drive-001','UPSERT','main','','Google Drive \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435','\u041f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u0441 \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435\u043c \u0438\u0437 Google Drive','FEED','IMAGE','MANUAL','','','[]','','','','','[{"source":"ASA Media","path":"lesson-01.jpg"}]','','','rev-1'],
  ['3','yandex-001','UPSERT','main','','\u042f\u043d\u0434\u0435\u043a\u0441 \u0414\u0438\u0441\u043a \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435','\u041f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u0441 \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435\u043c \u0438\u0437 \u042f\u043d\u0434\u0435\u043a\u0441 \u0414\u0438\u0441\u043a\u0430','FEED','IMAGE','MANUAL','','','[]','','','','','[{"source":"Yandex Media","path":"september/post-02.jpg"}]','','','rev-1'],
  ['3','at-001','UPSERT','main','','\u041f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u043f\u043e \u0432\u0440\u0435\u043c\u0435\u043d\u0438','\u0411\u0443\u0434\u0435\u0442 \u043e\u043f\u0443\u0431\u043b\u0438\u043a\u043e\u0432\u0430\u043d\u0430 \u0432 \u0443\u043a\u0430\u0437\u0430\u043d\u043d\u043e\u0435 \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e\u0435 \u0432\u0440\u0435\u043c\u044f','FEED','IMAGE','AT','2026-09-20 14:00','Europe/Moscow','[]','','','','','','','','rev-1'],
  ['3','queue-001','UPSERT','main','','\u041f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u0432 \u043e\u0447\u0435\u0440\u0435\u0434\u044c','\u0413\u043e\u0442\u043e\u0432\u044b\u0439 \u043c\u0430\u0442\u0435\u0440\u0438\u0430\u043b \u0434\u043b\u044f \u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u0435\u0441\u043a\u043e\u0439 \u043e\u0447\u0435\u0440\u0435\u0434\u0438','FEED','IMAGE','QUEUE','','','[]','','','','','','','','rev-1']
];

const REFERENCE_ROWS = [
  ['schema_version','always','\u0412\u0435\u0440\u0441\u0438\u044f \u0441\u0445\u0435\u043c\u044b','3','3'],
  ['external_id','always','\u0421\u0442\u0430\u0431\u0438\u043b\u044c\u043d\u044b\u0439 ID \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u0438','1-160 chars, unique in source','post-2026-001'],
  ['action','always','\u041e\u043f\u0435\u0440\u0430\u0446\u0438\u044f','UPSERT / ARCHIVE / TRASH_REQUEST','UPSERT'],
  ['project','UPSERT','slug \u043f\u0440\u043e\u0435\u043a\u0442\u0430','existing project slug','main'],
  ['template_key','no','\u041f\u043e\u043a\u0430 \u043d\u0435 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0435\u0442\u0441\u044f','empty',''],
  ['internal_title','UPSERT','\u0412\u043d\u0443\u0442\u0440\u0435\u043d\u043d\u0438\u0439 \u0437\u0430\u0433\u043e\u043b\u043e\u0432\u043e\u043a','text','\u041d\u043e\u0432\u044b\u0439 \u0443\u0440\u043e\u043a'],
  ['body','UPSERT','\u041e\u0441\u043d\u043e\u0432\u043d\u043e\u0439 \u0442\u0435\u043a\u0441\u0442','text','\u0422\u0435\u043a\u0441\u0442 \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u0438'],
  ['publication_kind','UPSERT','\u0422\u0438\u043f \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u0438','FEED','FEED'],
  ['content_format','UPSERT','\u0424\u043e\u0440\u043c\u0430\u0442','IMAGE','IMAGE'],
  ['schedule_mode','UPSERT','\u0420\u0435\u0436\u0438\u043c \u0432\u044b\u043f\u0443\u0441\u043a\u0430','MANUAL / AT / QUEUE','QUEUE'],
  ['scheduled_at','AT only','\u0414\u0430\u0442\u0430/\u0432\u0440\u0435\u043c\u044f','YYYY-MM-DD HH:MM or ISO','2026-09-20 14:00'],
  ['timezone','AT recommended','IANA timezone','e.g. Europe/Moscow; UTC default','Europe/Moscow'],
  ['targets','optional','\u041f\u043b\u043e\u0449\u0430\u0434\u043a\u0438','JSON array of account selectors','[{"platform":"telegram","name":"\u041e\u0441\u043d\u043e\u0432\u043d\u043e\u0439 Telegram"}]'],
  ['telegram_body','optional','Override Telegram','selected Telegram target required',''],
  ['vk_body','optional','Override VK','selected VK target required',''],
  ['max_body','optional','Override MAX','selected MAX target required',''],
  ['instagram_body','optional','Override Instagram','selected Instagram target required',''],
  ['media','Google Sheets only','Cloud image references','JSON [{"source":"connector","path":"relative/file.jpg"}]','Google Drive/Yandex Disk; leave empty for direct XLSX import'],
  ['tags','no','\u041f\u043e\u043a\u0430 \u043d\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u044f\u0435\u0442\u0441\u044f','empty',''],
  ['source_note','no','\u041f\u043e\u043a\u0430 \u043d\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u044f\u0435\u0442\u0441\u044f','empty',''],
  ['source_revision','always','\u0420\u0435\u0432\u0438\u0437\u0438\u044f \u0438\u0441\u0445\u043e\u0434\u043d\u043e\u0439 \u0441\u0442\u0440\u043e\u043a\u0438','change on every semantic edit','rev-1 -> rev-2']
];

function setWidths(sheet: any, widths: number[]): void {
  widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
}

async function appendSafeRows(sheet: any, rows: string[][]): Promise<void> {
  for (const row of rows) await sheet.appendRow(row.map(spreadsheetSafeText));
}

export async function createCanonicalContentPlanV3Template(): Promise<Buffer> {
  const temp = path.join(config.dataDir, `.content-plan-v3-template-${crypto.randomUUID()}.xlsx`);
  try {
    const workbook = await createWriteOnlyWorkbook(toFile(temp));

    const posts = await workbook.addWorksheet('Posts');
    setWidths(posts, WIDTHS);
    await posts.appendRow([...CONTENT_PLAN_V3_COLUMNS]);
    await posts.close();

    const examples = await workbook.addWorksheet('Examples');
    setWidths(examples, WIDTHS);
    await examples.appendRow([...CONTENT_PLAN_V3_COLUMNS]);
    await appendSafeRows(examples, EXAMPLE_ROWS);
    await examples.close();

    const reference = await workbook.addWorksheet('Reference');
    setWidths(reference, [24,22,42,54,70]);
    await reference.appendRow(['column','required','purpose','allowed_or_format','example_or_note']);
    await appendSafeRows(reference, REFERENCE_ROWS);
    await reference.close();

    await workbook.finalize();
    return await fs.readFile(temp);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}
