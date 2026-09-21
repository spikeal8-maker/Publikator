import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWriteOnlyWorkbook, type WriteOnlyRowItem, type WriteOnlyStyle } from '@office-kit/xlsx/streaming';
import { toFile } from '@office-kit/xlsx/node';
import { makeAlignment, makeFont, makePatternFill, rgbColor } from '@office-kit/xlsx/styles';
import { config } from './config.js';
import { db } from './db.js';
import { CONTENT_PLAN_V3_COLUMNS, CONTENT_PLAN_V3_RU_COLUMNS } from './content-plan-v3.js';
import { spreadsheetSafeText } from './ingestion-security.js';

const WIDTHS = [12,24,18,20,18,34,70,20,18,22,28,22,48,60,60,60,60,52,28,36,20];
const HEADER_STYLE: WriteOnlyStyle = {
  font: makeFont({ bold: true, color: rgbColor('FFFFFF') }),
  fill: makePatternFill({ patternType: 'solid', fgColor: rgbColor('1F4E78') }),
  alignment: makeAlignment({ horizontal: 'center', vertical: 'center', wrapText: true })
};
const TITLE_STYLE: WriteOnlyStyle = {
  font: makeFont({ bold: true, color: rgbColor('FFFFFF'), size: 14 }),
  fill: makePatternFill({ patternType: 'solid', fgColor: rgbColor('315EE8') }),
  alignment: makeAlignment({ vertical: 'center', wrapText: true })
};
const NOTE_STYLE: WriteOnlyStyle = {
  fill: makePatternFill({ patternType: 'solid', fgColor: rgbColor('EAF0FF') }),
  alignment: makeAlignment({ vertical: 'top', wrapText: true })
};

function styledRow(values: string[], style: WriteOnlyStyle): WriteOnlyRowItem[] {
  return values.map((value) => ({ value: spreadsheetSafeText(value), style }));
}

function exampleRows(): string[][] {
  const project = (db.prepare('SELECT slug FROM projects ORDER BY created_at,slug LIMIT 1').get() as { slug: string } | undefined)?.slug ?? 'main';
  const driveSource = (db.prepare("SELECT name FROM ingestion_connectors WHERE enabled=1 AND type='google_drive' ORDER BY created_at,id LIMIT 1").get() as { name: string } | undefined)?.name ?? 'Мои файлы Google Drive';
  const yandexSource = (db.prepare("SELECT name FROM ingestion_connectors WHERE enabled=1 AND type='yandex_disk' ORDER BY created_at,id LIMIT 1").get() as { name: string } | undefined)?.name ?? 'Мои файлы Яндекс Диск';
  const accounts = db.prepare('SELECT platform,name FROM social_accounts WHERE enabled=1 ORDER BY platform,name,id LIMIT 2').all() as Array<{ platform: string; name: string }>;
  const targets = accounts.map((account) => `${account.platform}:${account.name}`).join('; ');
  const templateExample = db.prepare(`SELECT t.key,p.slug AS project
    FROM templates t JOIN projects p ON p.id=t.project_id
    WHERE t.template_type='POST'
    ORDER BY t.updated_at DESC,t.key LIMIT 1`).get() as { key: string; project: string } | undefined;

  return [
    ['3','manual-001','UPSERT',project,'','Ручная публикация','Введите основной текст публикации','FEED','IMAGE','MANUAL','','','', '', '', '', '', '', '', '', '1'],
    ['3','drive-001','UPSERT',project,'','Изображение из Google Drive','Publikator найдёт файл по имени и сохранит его локально','FEED','IMAGE','MANUAL','','','', '', '', '', '', `${driveSource}|lesson-01.jpg`, '', '', '1'],
    ['3','yandex-001','UPSERT',project,'','Изображение из Яндекс Диска','Можно указывать подпапки относительно настроенного корня','FEED','IMAGE','MANUAL','','','', '', '', '', '', `${yandexSource}|september/post-02.jpg`, '', '', '1'],
    ['3','at-001','UPSERT',project,'','Публикация по времени','Будет опубликована в указанное локальное время','FEED','IMAGE','AT','2026-09-20T14:00','Europe/Moscow','', '', '', '', '', '', '', '', '1'],
    ['3','queue-001','UPSERT',project,'','Публикация в очередь','Будет ждать подходящего автоматического слота','FEED','IMAGE','QUEUE','','','', '', '', '', '', '', '', '', '1'],
    ['3','targets-001','UPSERT',project,'','Публикация на площадки','Площадки можно перечислять через точку с запятой','FEED','IMAGE','MANUAL','','',targets,'**Отдельный текст Telegram**','_Отдельный текст VK_','','','','','','1'],
    ['3','template-rich-001','UPSERT',templateExample?.project ?? project,templateExample?.key ?? '','Шаблон + rich text','**Новый модуль**\n[Подробнее](https://example.org)\n> Важно','STORY','STORY_SEQUENCE','MANUAL','','','', '', '', '', '', '', 'новости; запуск', 'Материал от редакции', '1']
  ];
}

const COLUMN_GUIDE = [
  ['Версия','Обязательно','Версия формата таблицы','Всегда 3','schema_version'],
  ['ID публикации','Обязательно','Стабильный ID строки. Не меняйте его при редактировании одной и той же публикации.','До 160 символов','external_id'],
  ['Действие','Обязательно','Что сделать с публикацией','UPSERT; ARCHIVE; TRASH_REQUEST','action'],
  ['Проект','Для UPSERT','Проект из листа «Справочники»','slug проекта','project'],
  ['Шаблон','Необязательно','POST template того же проекта. Используется снимком только при создании NEW.','Ключ из листа «Справочники»; пусто = без шаблона','template_key'],
  ['Название','Для UPSERT','Понятное внутреннее название. Всегда задаётся явно в таблице.','Текст','internal_title'],
  ['Текст','Для UPSERT','Основной portable rich text. Если пусто при NEW с template_key — берётся из шаблона.','**bold**; _italic_; ~~strike~~; `code`; [link](https://example.org); > quote','body'],
  ['Тип публикации','Для UPSERT','Canonical publication kind. Пусто с template_key = значение шаблона.','FEED / SHORT / STORY','publication_kind'],
  ['Формат','Для UPSERT','Canonical content format. Пусто с template_key = значение шаблона.','TEXT_ONLY / IMAGE / CAROUSEL / VIDEO / VERTICAL_VIDEO / STORY_SEQUENCE','content_format'],
  ['Режим публикации','Для UPSERT','MANUAL — вручную; AT — по времени; QUEUE — очередь','MANUAL / AT / QUEUE','schedule_mode'],
  ['Дата и время','Только AT','Когда опубликовать','YYYY-MM-DDTHH:mm или ISO с Z/offset','scheduled_at'],
  ['Часовой пояс','Рекомендуется для AT','Часовой пояс публикации','Например Europe/Moscow','timezone'],
  ['Площадки','Необязательно','Куда публиковать','telegram:Имя; vk:Имя или старый JSON','targets'],
  ['Текст Telegram','Необязательно','Portable rich override только для Telegram','Тот же neutral syntax, что у основного текста','telegram_body'],
  ['Текст VK','Необязательно','Portable rich override только для VK','Тот же neutral syntax, что у основного текста','vk_body'],
  ['Текст MAX','Необязательно','Portable rich override только для MAX','Тот же neutral syntax, что у основного текста','max_body'],
  ['Текст Instagram','Необязательно','Portable rich override только для Instagram','Тот же neutral syntax, что у основного текста','instagram_body'],
  ['Медиа','Google Sheets','Файл из подключённого Google Drive/Яндекс Диска','Источник|путь/файл.jpg; несколько через ;','media'],
  ['Теги','Необязательно','Внутренние теги публикации. Не отправляются в соцсети.','школа; робототехника; сентябрь или JSON-массив','tags'],
  ['Заметка','Необязательно','Внутренняя заметка источника. Не отправляется в соцсети.','Происхождение материала / контекст','source_note'],
  ['Ревизия','Обязательно','Меняйте при каждом смысловом изменении строки','1 → 2 → 3','source_revision']
];

function setWidths(sheet: any, widths: number[]): void {
  widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
}
async function appendSafeRows(sheet: any, rows: string[][]): Promise<void> {
  for (const row of rows) await sheet.appendRow(row.map(spreadsheetSafeText));
}
function listRows(): string[][] {
  const projects = db.prepare('SELECT slug FROM projects ORDER BY slug').all() as Array<{ slug: string }>;
  const templates = db.prepare("SELECT key FROM templates WHERE template_type='POST' ORDER BY key").all() as Array<{ key: string }>;
  const accounts = db.prepare('SELECT platform,name FROM social_accounts WHERE enabled=1 ORDER BY platform,name').all() as Array<{ platform: string; name: string }>;
  const sources = db.prepare("SELECT type,name FROM ingestion_connectors WHERE enabled=1 AND type IN ('google_drive','yandex_disk') ORDER BY type,name").all() as Array<{ type: string; name: string }>;
  const kinds = ['FEED','SHORT','STORY'];
  const formats = ['TEXT_ONLY','IMAGE','CAROUSEL','VIDEO','VERTICAL_VIDEO','STORY_SEQUENCE'];
  const modes = ['MANUAL','AT','QUEUE'];
  const actions = ['UPSERT','ARCHIVE','TRASH_REQUEST'];
  const max = Math.max(projects.length, templates.length, accounts.length, sources.length, kinds.length, formats.length, modes.length, actions.length);
  const rows: string[][] = [];
  for (let index = 0; index < max; index += 1) rows.push([
    projects[index]?.slug ?? '',
    templates[index]?.key ?? '',
    accounts[index]?.platform ?? '',
    accounts[index]?.name ?? '',
    sources[index]?.name ?? '',
    sources[index]?.type === 'google_drive' ? 'Google Drive' : sources[index]?.type === 'yandex_disk' ? 'Яндекс Диск' : '',
    kinds[index] ?? '', formats[index] ?? '', modes[index] ?? '', actions[index] ?? ''
  ]);
  return rows;
}

const QUICK_START = [
  ['1','Откройте лист `Posts`.','Это единственный лист, который Publikator импортирует.','Не удаляйте и не переставляйте колонки.'],
  ['2','Если не знаете, как начать — скопируйте подходящую строку с листа `Examples`.','Замените ID, проект, название, текст и ревизию.','Примеры сами не импортируются.'],
  ['3','Выберите проект из листа `Lists`.','Например: main','Проект должен уже существовать в Publikator.'],
  ['4','Укажите площадки коротко.','telegram:Основной Telegram; vk:Школа VK','Можно оставить пустым и выбрать площадки позже в Publikator.'],
  ['5','Для Google Sheets можно указать облачное изображение.','ASA Media|lesson-01.jpg','Несколько файлов: разделяйте точкой с запятой. Для прямого XLSX import поле «Медиа» оставьте пустым.'],
  ['6','Выберите режим публикации.','MANUAL — вручную; AT — по времени; QUEUE — автоматическая очередь','Для AT обязательно заполните дату/время; часовой пояс рекомендуется.'],
  ['7','Меняйте «Ревизию» при каждом смысловом изменении строки.','1 → 2 → 3','ID публикации при этом должен оставаться прежним.'],
  ['8','Всегда сначала запускайте Preview.','Preview покажет NEW / UPDATE / UNCHANGED / CONFLICT / ERROR.','Preview не меняет данные Publikator.'],
  ['9','Удаление строки из таблицы не удаляет публикацию.','Для удаления/архива используйте явное действие или интерфейс Publikator.','Это защита от случайной потери контента.'],
  ['10','Служебные колонки справа заполняет Publikator.','V:Y — импорт; Z:AD — результат публикации.','Не используйте их как входные данные.']
];

export async function createCanonicalContentPlanV3Template(): Promise<Buffer> {
  const temp = path.join(config.dataDir, `.content-plan-v3-template-${crypto.randomUUID()}.xlsx`);
  try {
    const workbook = await createWriteOnlyWorkbook(toFile(temp));

    const help = await workbook.addWorksheet('Instructions');
    setWidths(help, [8,42,72,72]);
    await help.appendRow(styledRow(['Publikator — шаблон контент-плана','','',''], TITLE_STYLE));
    await help.appendRow(styledRow(['Шаг','Что сделать','Пример','Важно'], HEADER_STYLE));
    for (const row of QUICK_START) await help.appendRow(styledRow(row, NOTE_STYLE));
    await help.close();

    const posts = await workbook.addWorksheet('Posts');
    setWidths(posts, WIDTHS);
    await posts.appendRow(styledRow([...CONTENT_PLAN_V3_RU_COLUMNS], HEADER_STYLE));
    await posts.close();

    const lists = await workbook.addWorksheet('Lists');
    setWidths(lists, [24,28,20,34,34,22,22,24,24,24]);
    await lists.appendRow(styledRow(['Проект','Шаблон','Платформа','Подключение','Источник медиа','Тип источника','Тип публикации','Формат','Режим публикации','Действие'], HEADER_STYLE));
    await appendSafeRows(lists, listRows());
    await lists.close();

    const examples = await workbook.addWorksheet('Examples');
    setWidths(examples, WIDTHS);
    await examples.appendRow(styledRow([...CONTENT_PLAN_V3_RU_COLUMNS], HEADER_STYLE));
    await appendSafeRows(examples, exampleRows());
    await examples.close();

    const guide = await workbook.addWorksheet('Fields');
    setWidths(guide, [28,22,72,48,28]);
    await guide.appendRow(styledRow(['Поле','Когда нужно','Что вводить','Допустимые значения / пример','Техническое имя'], HEADER_STYLE));
    await appendSafeRows(guide, COLUMN_GUIDE);
    await guide.close();

    await workbook.finalize();
    return await fs.readFile(temp);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}
