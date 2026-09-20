import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWriteOnlyWorkbook, loadWorkbookStream } from '@office-kit/xlsx/streaming';
import { fromBuffer, toFile } from '@office-kit/xlsx/node';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cp2-006c-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cp2-006c-password';
process.env.APP_MASTER_KEY = 'cp2-006c-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'object' && typeof value.text === 'string') return value.text;
  return String(value);
}
async function sheetRows(workbook, name) {
  const sheet = workbook.openWorksheet(name);
  const rows = [];
  for await (const row of sheet.iterRows()) rows.push(row.map((cell) => cellText(cell.value)));
  return rows;
}
try {
  const { db, migrate, nowIso } = await import('../dist/db.js');
  migrate();
  const now = nowIso();
  db.prepare("INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES ('tg-template','telegram','Основной Telegram','test',1,?,?)").run(now, now);
  db.prepare("INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES ('vk-template','vk','Школа VK','test',1,?,?)").run(now, now);
  const { createIngestionConnector } = await import('../dist/integration-security.js');
  const { createTemplate } = await import('../dist/templates.js');
  const project = db.prepare('SELECT id FROM projects ORDER BY created_at,id LIMIT 1').get();
  const editorialTemplate = createTemplate({
    key: 'sheet-template-v3',
    name: 'Sheet Template v3',
    projectId: project.id,
    templateType: 'POST',
    bodyRich: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Template', marks: [{ type: 'bold' }] }] }] },
    publicationKind: 'FEED',
    contentFormat: 'IMAGE',
    scheduleMode: 'MANUAL',
    targetAccountIds: ['tg-template','vk-template']
  });
  createIngestionConnector({ type: 'google_drive', name: 'ASA Media', config: { rootFolderId: 'root-drive', rootFolderName: 'Drive Root' }, credentials: { test: 'drive' } });
  createIngestionConnector({ type: 'yandex_disk', name: 'Yandex Media', config: { rootPath: 'disk:/Publikator', rootFolderName: 'Yandex Root' }, credentials: { test: 'yandex' } });

  const { CONTENT_PLAN_V3_COLUMNS, CONTENT_PLAN_V3_RU_COLUMNS, parseContentPlanV3, validateContentPlanV3 } = await import('../dist/content-plan-v3.js');
  const { createCanonicalContentPlanV3Template } = await import('../dist/content-plan-v3-template.js');
  const { parseCloudMediaReferences } = await import('../dist/cloud-media-reference.js');
  const template = await createCanonicalContentPlanV3Template();
  assert.ok(template.byteLength > 1500, 'template is unexpectedly small');

  const workbook = await loadWorkbookStream(fromBuffer(template));
  try {
    assert.deepEqual(workbook.sheetNames, ['Как пользоваться','Публикации','Справочники','Примеры','Описание полей']);
    const help = await sheetRows(workbook, 'Как пользоваться');
    assert.match(help[0][0], /Publikator/i);
    assert.deepEqual(help[1], ['Шаг','Что сделать','Пример','Важно']);
    assert.ok(help.some((row) => /telegram:Основной Telegram/.test(row.join(' '))));
    assert.ok(help.some((row) => /ASA Media\|lesson-01\.jpg/.test(row.join(' '))));
    assert.ok(help.some((row) => /Preview/.test(row.join(' '))));

    const posts = await sheetRows(workbook, 'Публикации');
    assert.equal(posts.length, 1, 'Публикации must contain header only');
    assert.deepEqual(posts[0], [...CONTENT_PLAN_V3_RU_COLUMNS]);

    const lists = await sheetRows(workbook, 'Справочники');
    assert.deepEqual(lists[0], ['Проект','Шаблон','Платформа','Подключение','Источник медиа','Тип источника','Тип публикации','Формат','Режим публикации','Действие']);
    assert.ok(lists.some((row) => row.includes('Основной Telegram')));
    assert.ok(lists.some((row) => row.includes('Школа VK')));
    assert.ok(lists.some((row) => row.includes('ASA Media') && row.includes('Google Drive')));
    assert.ok(lists.some((row) => row.includes('Yandex Media') && row.includes('Яндекс Диск')));
    assert.ok(lists.some((row) => row.includes(editorialTemplate.key)));
    for (const value of ['FEED','SHORT','STORY']) assert.ok(lists.some((row) => row.includes(value)));
    for (const value of ['TEXT_ONLY','IMAGE','CAROUSEL','VIDEO','VERTICAL_VIDEO','STORY_SEQUENCE']) assert.ok(lists.some((row) => row.includes(value)));

    const examples = await sheetRows(workbook, 'Примеры');
    assert.equal(examples.length, 8);
    assert.deepEqual(examples[0], [...CONTENT_PLAN_V3_RU_COLUMNS]);
    assert.equal(examples[1][5], 'Ручная публикация');
    assert.equal(examples[3][5], 'Изображение из Яндекс Диска');
    const mediaIndex = CONTENT_PLAN_V3_RU_COLUMNS.indexOf('Медиа');
    const drive = parseCloudMediaReferences(examples[2][mediaIndex]);
    assert.equal(drive.managed, true);
    assert.deepEqual(drive.references[0], { source: 'ASA Media', path: 'lesson-01.jpg' });
    const yandex = parseCloudMediaReferences(examples[3][mediaIndex]);
    assert.equal(yandex.managed, true);
    assert.deepEqual(yandex.references[0], { source: 'Yandex Media', path: 'september/post-02.jpg' });
    const multiple = parseCloudMediaReferences('ASA Media|one.jpg; Yandex Media|folder/two.jpg');
    assert.equal(multiple.references.length, 2);

    const fieldGuide = await sheetRows(workbook, 'Описание полей');
    assert.deepEqual(fieldGuide[0], ['Поле','Когда нужно','Что вводить','Допустимые значения / пример','Техническое имя']);
    assert.equal(fieldGuide.length, CONTENT_PLAN_V3_COLUMNS.length + 1);
    assert.deepEqual(fieldGuide.slice(1).map((row) => row[4]), [...CONTENT_PLAN_V3_COLUMNS]);
    const targetsGuide = fieldGuide.find((row) => row[0] === 'Площадки');
    assert.match(targetsGuide.join(' '), /telegram:Имя/);
    const mediaGuide = fieldGuide.find((row) => row[0] === 'Медиа');
    assert.match(mediaGuide.join(' '), /Источник\|путь/);
    const templateGuide = fieldGuide.find((row) => row[0] === 'Шаблон');
    assert.match(templateGuide.join(' '), /POST template/);
    const bodyGuide = fieldGuide.find((row) => row[0] === 'Текст');
    assert.match(bodyGuide.join(' '), /\*\*bold\*\*/);
    assert.match(bodyGuide.join(' '), /\[link\]/);
    assert.equal(JSON.stringify([help, lists, examples, fieldGuide]).includes(String.fromCharCode(92) + 'u04'), false, 'template must contain readable Cyrillic');
    const smokePath = path.join(dataDir, 'template-human-smoke.xlsx');
    const smokeBook = await createWriteOnlyWorkbook(toFile(smokePath));
    const intro = await smokeBook.addWorksheet('Как пользоваться');
    await intro.appendRow(['Этот лист не является импортом']);
    await intro.close();
    const smokeSheet = await smokeBook.addWorksheet('Публикации');
    await smokeSheet.appendRow([...CONTENT_PLAN_V3_RU_COLUMNS]);
    await smokeSheet.appendRow(examples[1]);
    await smokeSheet.appendRow(examples[6]);
    await smokeSheet.appendRow(examples[7]);
    await smokeSheet.close();
    await smokeBook.finalize();
    const smokeBuffer = await fs.readFile(smokePath);
    const smokeParsed = await parseContentPlanV3('template-human-smoke.xlsx', smokeBuffer);
    const smokeValidation = await validateContentPlanV3(smokeParsed, 'template-human-smoke');
    assert.equal(smokeValidation.canApply, true, JSON.stringify(smokeValidation));
    assert.equal(smokeValidation.rows.length, 3);
    assert.equal(smokeValidation.rows[0].classification, 'NEW');
    assert.equal(smokeValidation.rows[1].classification, 'NEW');
    assert.equal(smokeValidation.rows[2].classification, 'NEW');
    assert.deepEqual(smokeValidation.rows[1].normalized.targets.map((target) => target.accountId).sort(), ['tg-template','vk-template']);
    assert.equal(smokeValidation.rows[2].normalized.templateKey, editorialTemplate.key);
    assert.equal(smokeValidation.rows[2].normalized.publicationKind, 'STORY');
    assert.equal(smokeValidation.rows[2].normalized.contentFormat, 'STORY_SEQUENCE');
    assert.ok(JSON.stringify(JSON.parse(smokeValidation.rows[2].normalized.bodyRichJson)).includes('"type":"bold"'));
    assert.ok(JSON.stringify(JSON.parse(smokeValidation.rows[2].normalized.bodyRichJson)).includes('"type":"link"'));
    assert.ok(JSON.stringify(JSON.parse(smokeValidation.rows[2].normalized.bodyRichJson)).includes('"type":"blockquote"'));

    const machinePath = path.join(dataDir, 'template-machine-smoke.xlsx');
    const machineBook = await createWriteOnlyWorkbook(toFile(machinePath));
    const machineSheet = await machineBook.addWorksheet('Posts');
    await machineSheet.appendRow([...CONTENT_PLAN_V3_COLUMNS]);
    await machineSheet.appendRow(examples[1]);
    await machineSheet.close();
    await machineBook.finalize();
    const machineBuffer = await fs.readFile(machinePath);
    const machineParsed = await parseContentPlanV3('template-machine-smoke.xlsx', machineBuffer);
    const machineValidation = await validateContentPlanV3(machineParsed, 'template-machine-smoke');
    assert.equal(machineValidation.canApply, true, JSON.stringify(machineValidation));
    assert.equal(machineValidation.rows[0].classification, 'NEW');
  } finally {
    await workbook.close();
  }

  const { buildApp } = await import('../dist/app.js');
  const app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const schema = await app.inject({ method: 'GET', url: '/api/content-plan/v3/schema', headers: { cookie } });
  assert.equal(schema.statusCode, 200, schema.body);
  assert.deepEqual(schema.json().columns, [...CONTENT_PLAN_V3_COLUMNS]);
  assert.deepEqual(schema.json().russianColumns, [...CONTENT_PLAN_V3_RU_COLUMNS]);
  assert.match(schema.json().humanInput.targets, /telegram:/);
  assert.match(schema.json().humanInput.media, /Cloud Source\|/);
  const endpoint = await app.inject({ method: 'GET', url: '/api/content-plan/v3/template.xlsx', headers: { cookie } });
  assert.equal(endpoint.statusCode, 200, endpoint.body);
  assert.match(String(endpoint.headers['content-type']), /spreadsheetml\.sheet/);
  assert.equal(endpoint.headers['content-disposition'], 'attachment; filename="publikator-content-plan-v3-template.xlsx"');
  await app.close();

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'UX-SHEETS-001',
    russianOperatorTemplate: true,
    russianHeaderAliases: true,
    machineHeadersBackwardCompatible: true,
    shortTargets: true,
    shortCloudMedia: true,
    humanFirstSheet: true
  }, null, 2));
} finally {
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
