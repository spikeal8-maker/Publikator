import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadWorkbookStream } from '@office-kit/xlsx/streaming';
import { fromBuffer } from '@office-kit/xlsx/node';

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
  const { CONTENT_PLAN_V3_COLUMNS } = await import('../dist/content-plan-v3.js');
  const { createCanonicalContentPlanV3Template } = await import('../dist/content-plan-v3-template.js');
  const { parseCloudMediaReferences } = await import('../dist/cloud-media-reference.js');
  const template = await createCanonicalContentPlanV3Template();
  assert.ok(template.byteLength > 1000, 'template is unexpectedly small');

  const workbook = await loadWorkbookStream(fromBuffer(template));
  try {
    assert.deepEqual(workbook.sheetNames, ['Posts', 'Examples', 'Reference']);
    const posts = await sheetRows(workbook, 'Posts');
    assert.equal(posts.length, 1, 'Posts must contain header only');
    assert.deepEqual(posts[0], [...CONTENT_PLAN_V3_COLUMNS]);

    const examples = await sheetRows(workbook, 'Examples');
    assert.equal(examples.length, 6);
    assert.deepEqual(examples[0], [...CONTENT_PLAN_V3_COLUMNS]);
    assert.equal(examples[1][5], '\u0420\u0443\u0447\u043d\u0430\u044f \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f');
    assert.equal(examples[3][5], '\u042f\u043d\u0434\u0435\u043a\u0441 \u0414\u0438\u0441\u043a \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435');
    const mediaIndex = CONTENT_PLAN_V3_COLUMNS.indexOf('media');
    const scheduleIndex = CONTENT_PLAN_V3_COLUMNS.indexOf('schedule_mode');
    const timezoneIndex = CONTENT_PLAN_V3_COLUMNS.indexOf('timezone');
    const drive = parseCloudMediaReferences(examples[2][mediaIndex]);
    assert.equal(drive.managed, true);
    assert.equal(drive.references[0].source, 'ASA Media');
    assert.equal(drive.references[0].path, 'lesson-01.jpg');
    const yandex = parseCloudMediaReferences(examples[3][mediaIndex]);
    assert.equal(yandex.managed, true);
    assert.equal(yandex.references[0].source, 'Yandex Media');
    assert.equal(yandex.references[0].path, 'september/post-02.jpg');
    assert.equal(examples[4][scheduleIndex], 'AT');
    assert.equal(examples[4][timezoneIndex], 'Europe/Moscow');
    assert.equal(examples[5][scheduleIndex], 'QUEUE');
    const reference = await sheetRows(workbook, 'Reference');
    assert.equal(reference.length, CONTENT_PLAN_V3_COLUMNS.length + 1);
    assert.deepEqual(reference[0], ['column','required','purpose','allowed_or_format','example_or_note']);
    assert.deepEqual(reference.slice(1).map((row) => row[0]), [...CONTENT_PLAN_V3_COLUMNS]);
    const mediaReference = reference.find((row) => row[0] === 'media');
    assert.match(mediaReference.join(' '), /Google Drive\/Yandex Disk/i);
    assert.match(mediaReference.join(' '), /direct XLSX import/i);
  } finally {
    await workbook.close();
  }

  const { migrate } = await import('../dist/db.js');
  const { buildApp } = await import('../dist/app.js');
  migrate();
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
