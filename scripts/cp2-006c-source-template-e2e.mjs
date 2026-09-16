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
  db.prepare("INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES ('tg-template','telegram','Template Telegram','test',1,?,?)").run(now, now);
  db.prepare("INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at) VALUES ('vk-template','vk','Template VK','test',1,?,?)").run(now, now);
  const { createIngestionConnector } = await import('../dist/integration-security.js');
  createIngestionConnector({ type: 'google_drive', name: 'Drive Photos', config: { rootFolderId: 'root-drive', rootFolderName: 'Drive Root' }, credentials: { test: 'drive' } });
  createIngestionConnector({ type: 'yandex_disk', name: 'Yandex Photos', config: { rootPath: 'disk:/Publikator', rootFolderName: 'Yandex Root' }, credentials: { test: 'yandex' } });
  const { CONTENT_PLAN_V3_COLUMNS } = await import('../dist/content-plan-v3.js');
  const { createCanonicalContentPlanV3Template } = await import('../dist/content-plan-v3-template.js');
  const { parseCloudMediaReferences } = await import('../dist/cloud-media-reference.js');
  const template = await createCanonicalContentPlanV3Template();
  assert.ok(template.byteLength > 1000, 'template is unexpectedly small');

  const workbook = await loadWorkbookStream(fromBuffer(template));
  try {
    assert.deepEqual(workbook.sheetNames, ['Posts', 'Lists', 'Instructions', 'Examples']);
    const posts = await sheetRows(workbook, 'Posts');
    assert.equal(posts.length, 1, 'Posts must contain header only');
    assert.deepEqual(posts[0], [...CONTENT_PLAN_V3_COLUMNS]);

    const lists = await sheetRows(workbook, 'Lists');
    assert.deepEqual(lists[0], ['project_slug','account_platform','account_name','cloud_media_source','cloud_media_provider','publication_kind','content_format','schedule_mode','action','template_key']);
    assert.ok(lists.some((row) => row.includes('FEED')));
    assert.ok(lists.some((row) => row.includes('IMAGE')));
    assert.ok(lists.some((row) => row.includes('MANUAL')));
    assert.ok(lists.some((row) => row.includes('AT')));
    assert.ok(lists.some((row) => row.includes('QUEUE')));
    assert.ok(lists.some((row) => row.includes('Template Telegram')));
    assert.ok(lists.some((row) => row.includes('Template VK')));
    assert.ok(lists.some((row) => row.includes('Drive Photos') && row.includes('google_drive')));
    assert.ok(lists.some((row) => row.includes('Yandex Photos') && row.includes('yandex_disk')));
    const instructions = await sheetRows(workbook, 'Instructions');
    assert.deepEqual(instructions[0], ['section','name_or_step','guidance','allowed_or_format','example_or_note']);
    assert.ok(instructions.some((row) => row[0] === 'workflow' && /Posts/.test(row[2])));
    const columnRows = instructions.filter((row) => row[0] === 'column');
    assert.equal(columnRows.length, CONTENT_PLAN_V3_COLUMNS.length);
    assert.deepEqual(columnRows.map((row) => row[1]), [...CONTENT_PLAN_V3_COLUMNS]);
    const mediaInstruction = columnRows.find((row) => row[1] === 'media');
    assert.match(mediaInstruction.join(' '), /Google Drive\/Yandex Disk/i);
    assert.match(mediaInstruction.join(' '), /direct XLSX import/i);

    const examples = await sheetRows(workbook, 'Examples');
    assert.equal(examples.length, 7);
    assert.deepEqual(examples[0], [...CONTENT_PLAN_V3_COLUMNS]);
    assert.equal(examples[1][5], 'Ручная публикация');
    assert.equal(examples[3][5], 'Яндекс Диск изображение');
    const mediaIndex = CONTENT_PLAN_V3_COLUMNS.indexOf('media');
    const scheduleIndex = CONTENT_PLAN_V3_COLUMNS.indexOf('schedule_mode');
    const timezoneIndex = CONTENT_PLAN_V3_COLUMNS.indexOf('timezone');
    const drive = parseCloudMediaReferences(examples[2][mediaIndex]);
    assert.equal(drive.managed, true);
    assert.equal(drive.references[0].source, 'Drive Photos');
    assert.equal(drive.references[0].path, 'lesson-01.jpg');
    const yandex = parseCloudMediaReferences(examples[3][mediaIndex]);
    assert.equal(yandex.managed, true);
    assert.equal(yandex.references[0].source, 'Yandex Photos');
    assert.equal(yandex.references[0].path, 'september/post-02.jpg');
    assert.equal(examples[4][scheduleIndex], 'AT');
    assert.equal(examples[4][timezoneIndex], 'Europe/Moscow');
    assert.equal(examples[5][scheduleIndex], 'QUEUE');
    const targets = JSON.parse(examples[6][CONTENT_PLAN_V3_COLUMNS.indexOf('targets')]);
    assert.deepEqual(targets, [
      { platform: 'telegram', name: 'Template Telegram' },
      { platform: 'vk', name: 'Template VK' }
    ].sort((a,b) => `${a.platform}/${a.name}`.localeCompare(`${b.platform}/${b.name}`)));
    assert.equal(JSON.stringify(examples).includes(String.fromCharCode(92) + 'u04'), false, 'template must contain readable Cyrillic, not literal unicode escapes');

    const smokePath = path.join(dataDir, 'template-filled-smoke.xlsx');
    const smokeBook = await createWriteOnlyWorkbook(toFile(smokePath));
    const smokeSheet = await smokeBook.addWorksheet('Posts');
    await smokeSheet.appendRow(posts[0]);
    await smokeSheet.appendRow(examples[1]);
    await smokeSheet.close();
    await smokeBook.finalize();
    const { parseContentPlanV3, validateContentPlanV3 } = await import('../dist/content-plan-v3.js');
    const smokeBuffer = await fs.readFile(smokePath);
    const smokeParsed = await parseContentPlanV3('template-filled-smoke.xlsx', smokeBuffer);
    const smokeValidation = await validateContentPlanV3(smokeParsed, 'template-smoke');
    assert.equal(smokeValidation.canApply, true, JSON.stringify(smokeValidation));
    assert.equal(smokeValidation.rows[0].classification, 'NEW');
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
  assert.equal(schema.json().foundationLimits.media.directFileImport, 'leave empty');
  assert.match(schema.json().foundationLimits.media.googleSheets, /Google Drive\/Yandex Disk/);

  const endpoint = await app.inject({ method: 'GET', url: '/api/content-plan/v3/template.xlsx', headers: { cookie } });
  assert.equal(endpoint.statusCode, 200, endpoint.body);
  assert.match(String(endpoint.headers['content-type']), /spreadsheetml\.sheet/);
  assert.equal(endpoint.headers['content-disposition'], 'attachment; filename="publikator-content-plan-v3-template.xlsx"');
  await app.close();
  console.log('CP2-006C canonical source template: PASS');
} finally {
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
