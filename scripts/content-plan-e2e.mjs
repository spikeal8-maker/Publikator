import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-content-plan-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'content-plan-ci-password';
process.env.APP_MASTER_KEY = 'content-plan-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';
process.env.EVENT_RETENTION_DAYS = '0';
process.env.BACKUP_RETENTION_COUNT = '0';

const sharp = (await import('sharp')).default;
const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { encryptJson } = await import('../dist/crypto.js');
const { saveImage } = await import('../dist/media.js');
const { ensureTargets, setTargetSelection } = await import('../dist/publisher.js');
const {
  exportContentPlanRows,
  serializeContentPlanCsv,
  createContentPlanXlsx,
  parseContentPlanFile,
  validateContentPlan,
  applyValidatedContentPlan
} = await import('../dist/content-plan.js');

migrate();

try {
  const project = db.prepare('SELECT id,slug FROM projects ORDER BY created_at LIMIT 1').get();
  assert.ok(project?.id && project?.slug);

  const accountId = id('acc');
  const now = nowIso();
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`)
    .run(
      accountId,
      'telegram',
      'Roundtrip channel',
      encryptJson({ botToken: 'fake-token', chatId: '@roundtrip' }),
      now,
      now
    );

  const title = 'Roundtrip; "quoted" title';
  const body = 'Line one; semicolon\n"Line two" with quotes';
  const override = 'Telegram; override\n"second line"';
  const scheduledAt = '2027-01-15T09:30:00.000Z';
  const sourcePostId = id('post');
  db.prepare(`INSERT INTO posts
    (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sourcePostId, project.id, title, body, 'DRAFT', 'AT', scheduledAt, nowIso(), nowIso());
  ensureTargets(sourcePostId);
  setTargetSelection(sourcePostId, [accountId]);
  db.prepare('UPDATE post_targets SET override_text=?,updated_at=? WHERE post_id=? AND account_id=?')
    .run(override, nowIso(), sourcePostId, accountId);

  const image = await sharp({
    create: {
      width: 48,
      height: 32,
      channels: 3,
      background: { r: 25, g: 100, b: 180 }
    }
  }).png().toBuffer();
  const sourceMedia = await saveImage(sourcePostId, 'source.png', image);

  const rows = exportContentPlanRows(project.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, title);
  assert.equal(rows[0].body, body);
  assert.equal(rows[0].scheduled_at, scheduledAt);
  assert.match(rows[0].targets, /Roundtrip channel/);
  assert.match(rows[0].platform_overrides, /Telegram; override/);
  assert.match(rows[0].media_references, new RegExp(sourceMedia.sha256));

  const csvBuffer = Buffer.from(serializeContentPlanCsv(rows), 'utf8');
  const xlsxBuffer = await createContentPlanXlsx(rows);
  assert.ok(csvBuffer.byteLength > 0);
  assert.ok(xlsxBuffer.byteLength > 0);

  const parsedCsv = await parseContentPlanFile('roundtrip.csv', csvBuffer);
  const parsedXlsx = await parseContentPlanFile('roundtrip.xlsx', xlsxBuffer);
  const csvValidation = await validateContentPlan(parsedCsv);
  const xlsxValidation = await validateContentPlan(parsedXlsx);

  for (const validation of [csvValidation, xlsxValidation]) {
    assert.equal(validation.canApply, true, JSON.stringify(validation.rows));
    assert.equal(validation.summary.totalRows, 1);
    const normalized = validation.rows[0].normalized;
    assert.ok(normalized);
    assert.equal(normalized.title, title);
    assert.equal(normalized.body, body);
    assert.equal(normalized.scheduleMode, 'AT');
    assert.equal(normalized.scheduledAt, scheduledAt);
    assert.equal(normalized.targets.length, 1);
    assert.equal(normalized.targets[0].accountId, accountId);
    assert.equal(normalized.overrides.length, 1);
    assert.equal(normalized.overrides[0].text, override);
    assert.equal(normalized.media.length, 1);
    assert.equal(normalized.media[0].sha256, sourceMedia.sha256);
  }

  const applied = await applyValidatedContentPlan(xlsxValidation);
  assert.equal(applied.createdCount, 1);
  assert.equal(applied.postIds.length, 1);
  assert.notEqual(applied.postIds[0], sourcePostId);

  const imported = db.prepare('SELECT * FROM posts WHERE id=?').get(applied.postIds[0]);
  assert.equal(imported.status, 'DRAFT');
  assert.equal(imported.title, title);
  assert.equal(imported.body, body);
  assert.equal(imported.schedule_mode, 'AT');
  assert.equal(imported.scheduled_at, scheduledAt);

  const importedTarget = db.prepare('SELECT * FROM post_targets WHERE post_id=? AND account_id=?').get(applied.postIds[0], accountId);
  assert.ok(importedTarget);
  assert.equal(importedTarget.enabled, 1);
  assert.equal(importedTarget.override_text, override);

  const importedMedia = db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order').all(applied.postIds[0]);
  assert.equal(importedMedia.length, 1);
  assert.notEqual(importedMedia[0].id, sourceMedia.id);
  assert.equal(importedMedia[0].sha256, sourceMedia.sha256);

  const invalidCsv = Buffer.from(
    `project;title;body;schedule_mode;scheduled_at;targets;platform_overrides;media_references\r\n${project.slug};Invalid AT row;This row must fail dry-run;AT;;[];[];[]\r\n`,
    'utf8'
  );
  const invalidValidation = await validateContentPlan(await parseContentPlanFile('invalid.csv', invalidCsv));
  assert.equal(invalidValidation.canApply, false);
  assert.equal(invalidValidation.summary.invalidRows, 1);
  assert.ok(invalidValidation.rows[0].issues.some((issue) => issue.level === 'error' && issue.column === 'scheduled_at'));

  console.log(JSON.stringify({
    ok: true,
    csvRoundtrip: true,
    xlsxRoundtrip: true,
    importedDraft: true,
    mediaShaPreserved: true,
    invalidAtRejected: true
  }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
