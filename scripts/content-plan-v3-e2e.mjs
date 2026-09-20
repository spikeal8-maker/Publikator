import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CURRENT_SCHEMA_VERSION } from './current-schema-version.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-content-v3-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'content-v3-ci-password';
process.env.APP_MASTER_KEY = 'content-v3-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate } = await import('../dist/db.js');
const { commitContentEdit, markReadyRevision } = await import('../dist/content-versioning.js');
const { buildApp } = await import('../dist/app.js');
const { parseContentPlanV3, validateContentPlanV3, applyContentPlanV3 } = await import('../dist/content-plan-v3.js');
const { createTemplate, updateTemplate } = await import('../dist/templates.js');
const { parseRichTextJson, richTextToPlain } = await import('../dist/rich-text.js');
migrate();
const app = await buildApp();
await app.ready();

const columns = [
  'schema_version','external_id','action','project','template_key','internal_title','body',
  'publication_kind','content_format','schedule_mode','scheduled_at','timezone','targets',
  'telegram_body','vk_body','max_body','instagram_body','media','tags','source_note','source_revision'
];

function rowValues({
  externalId = 'post-001', action = 'UPSERT', project = 'main', templateKey = '',
  body = 'First body', revision = 'rev-1', publicationKind = 'FEED', contentFormat = 'IMAGE',
  scheduleMode = 'MANUAL', scheduledAt = '', timezone = 'UTC', targets = [],
  telegramBody = '', vkBody = '', maxBody = '', instagramBody = '', title = 'Imported title'
} = {}) {
  return [
    '3', externalId, action, project, templateKey, title, body, publicationKind, contentFormat,
    scheduleMode, scheduledAt, timezone, JSON.stringify(targets),
    telegramBody, vkBody, maxBody, instagramBody, '', '', '', revision
  ];
}

function csvRows(rows) {
  const encodedRows = rows.map((values) =>
    values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(';')
  );
  return Buffer.from('\uFEFF' + columns.join(';') + '\r\n' + encodedRows.join('\r\n') + '\r\n');
}

function csv(options = {}) {
  return csvRows([rowValues(options)]);
}

async function preview(buffer, source = 'sheet-alpha') {
  return validateContentPlanV3(await parseContentPlanV3('content.csv', buffer), source);
}

function insertAccount(id, name, platform = 'telegram') {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO social_accounts (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?, ?, ?, 'encrypted-test', 1, ?, ?)`).run(id, platform, name, now, now);
}

try {
  assert.equal(Number(db.pragma('user_version', { simple: true })),CURRENT_SCHEMA_VERSION);
  const postColumns = db.prepare('PRAGMA table_info(posts)').all().map((row) => row.name);
  for (const name of ['source_type','source_ref','source_revision','source_payload_hash','source_batch_id','imported_at','imported_content_version']) {
    assert.ok(postColumns.includes(name), name);
  }

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ method: 'GET', url: '/api/content-plan/schema', headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/content-plan/v2/schema', headers: { cookie } })).statusCode, 404);
  const v3Schema = await app.inject({ method: 'GET', url: '/api/content-plan/v3/schema', headers: { cookie } });
  assert.equal(v3Schema.statusCode, 200);
  assert.equal(v3Schema.json().version, 3);
  const mainProject = db.prepare("SELECT id,slug,default_timezone FROM projects WHERE slug='main'").get();
  assert.ok(mainProject);

  let validation = await preview(csv());
  assert.equal(validation.rows[0].classification, 'NEW');
  assert.equal(validation.canApply, true);
  let result = applyContentPlanV3(validation, { actorSource: 'content_plan' });
  assert.equal(result.created, 1);

  let rows = db.prepare("SELECT * FROM posts WHERE source_type='content-plan-v3' ORDER BY created_at,id").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content_version, 1);
  assert.equal(rows[0].imported_content_version, 1);
  assert.match(rows[0].source_payload_hash, /^[a-f0-9]{64}$/);

  validation = await preview(csv());
  assert.equal(validation.rows[0].classification, 'UNCHANGED');
  result = applyContentPlanV3(validation, { actorSource: 'content_plan' });
  assert.equal(result.unchanged, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source_type='content-plan-v3'").get().n, 1);

  validation = await preview(csv({ body: 'Changed but reused revision', revision: 'rev-1' }));
  assert.equal(validation.rows[0].classification, 'ERROR');
  assert.equal(validation.canApply, false);
  assert.match(validation.rows[0].errors.join(' '), /source_revision/);

  validation = await preview(csv({ revision: 'rev-2' }));
  assert.equal(validation.rows[0].classification, 'UNCHANGED');
  applyContentPlanV3(validation, { actorSource: 'content_plan' });
  rows = db.prepare("SELECT * FROM posts WHERE source_type='content-plan-v3' ORDER BY created_at,id").all();
  assert.equal(rows[0].source_revision, 'rev-2');
  assert.equal(rows[0].content_version, 1);
  assert.equal(rows[0].imported_content_version, 1);

  validation = await preview(csv({ body: 'Second body', revision: 'rev-3' }));
  assert.equal(validation.rows[0].classification, 'UPDATE');
  result = applyContentPlanV3(validation, { actorSource: 'content_plan' });
  assert.equal(result.updated, 1);
  rows = db.prepare("SELECT * FROM posts WHERE source_type='content-plan-v3' ORDER BY created_at,id").all();
  assert.equal(rows[0].body, 'Second body');
  assert.equal(rows[0].content_version, 2);
  assert.equal(rows[0].imported_content_version, 2);
  assert.deepEqual(
    db.prepare('SELECT content_version,actor_source FROM content_revisions WHERE post_id=? ORDER BY content_version').all(rows[0].id),
    [
      { content_version: 1, actor_source: 'content_plan' },
      { content_version: 2, actor_source: 'content_plan' }
    ]
  );

  const postId = rows[0].id;
  commitContentEdit(postId, 2, 'manual', () => db.prepare("UPDATE posts SET body='Local edit' WHERE id=?").run(postId));
  validation = await preview(csv({ body: 'Third body', revision: 'rev-4' }));
  assert.equal(validation.rows[0].classification, 'CONFLICT');
  assert.equal(validation.canApply, false);
  assert.equal(db.prepare('SELECT body FROM posts WHERE id=?').get(postId).body, 'Local edit');

  const otherSource = await preview(csv({ body: 'Other source body' }), 'sheet-beta');
  assert.equal(otherSource.rows[0].classification, 'NEW');
  applyContentPlanV3(otherSource, { actorSource: 'content_plan' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source_type='content-plan-v3'").get().n, 2);

  insertAccount('tg-dup-1', 'Duplicate');
  insertAccount('tg-dup-2', 'Duplicate');
  const ambiguous = await preview(csv({ externalId: 'ambiguous-1', targets: [{ platform: 'telegram', name: 'Duplicate' }] }), 'sheet-targets');
  assert.equal(ambiguous.rows[0].classification, 'ERROR');
  assert.match(ambiguous.rows[0].errors.join(' '), /ambiguous account/);

  insertAccount('tg-a', 'Channel A');
  insertAccount('tg-b', 'Channel B');
  const multiTarget = await preview(csv({
    externalId: 'multi-target-1',
    targets: [{ accountId: 'tg-a' }, { accountId: 'tg-b' }],
    telegramBody: 'Shared Telegram override'
  }), 'sheet-targets');
  assert.equal(multiTarget.rows[0].classification, 'NEW');
  const multiResult = applyContentPlanV3(multiTarget, { actorSource: 'content_plan' });
  const selectedOverrides = db.prepare(`SELECT pt.account_id,pt.override_text,tr.text_rich_json,tr.text_plain
    FROM post_targets pt
    LEFT JOIN target_renditions tr ON tr.target_id=pt.id
    WHERE pt.post_id=? AND pt.enabled=1 ORDER BY pt.account_id`).all(multiResult.postIds[0]);
  assert.deepEqual(selectedOverrides.map((row) => ({
    account_id: row.account_id,
    override_text: row.override_text,
    text_plain: row.text_plain
  })), [
    { account_id: 'tg-a', override_text: null, text_plain: 'Shared Telegram override' },
    { account_id: 'tg-b', override_text: null, text_plain: 'Shared Telegram override' }
  ]);
  for (const row of selectedOverrides) {
    assert.ok(row.text_rich_json, 'new platform import override must own canonical rich JSON in TargetRendition');
    assert.equal(richTextToPlain(parseRichTextJson(row.text_rich_json)), 'Shared Telegram override');
    assert.equal(parseRichTextJson(row.text_rich_json).content[0].content[0].text, 'Shared Telegram override');
  }

  insertAccount('tpl-tg', 'Template TG', 'telegram');
  insertAccount('tpl-vk', 'Template VK', 'vk');
  insertAccount('tpl-max', 'Template MAX', 'max');

  const templateV1Rich = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Версия 1', marks: [{ type: 'bold' }] }] }]
  };
  const template = createTemplate({
    key: 'template-v1',
    name: 'Template v1',
    projectId: mainProject.id,
    templateType: 'POST',
    bodyRich: templateV1Rich,
    publicationKind: 'FEED',
    contentFormat: 'IMAGE',
    scheduleMode: 'MANUAL',
    targetAccountIds: ['tpl-tg', 'tpl-vk']
  });

  const templateRowV1 = {
    externalId: 'template-post-a',
    templateKey: template.key,
    body: '',
    publicationKind: '',
    contentFormat: '',
    scheduleMode: '',
    timezone: '',
    targets: [],
    title: 'Template Post A',
    revision: 'rev-1'
  };
  let templatePreview = await preview(csv(templateRowV1), 'sheet-template');
  assert.equal(templatePreview.rows[0].classification, 'NEW');
  assert.equal(templatePreview.canApply, true);
  const templateCreateA = applyContentPlanV3(templatePreview, { actorSource: 'content_plan' });
  const templatePostA = db.prepare('SELECT * FROM posts WHERE id=?').get(templateCreateA.postIds[0]);
  assert.equal(templatePostA.status, 'DRAFT');
  assert.equal(templatePostA.body, 'Версия 1');
  assert.equal(templatePostA.publication_kind, 'FEED');
  assert.equal(templatePostA.content_format, 'IMAGE');
  assert.equal(parseRichTextJson(templatePostA.body_rich_json).content[0].content[0].marks[0].type, 'bold');
  assert.deepEqual(
    db.prepare('SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1 ORDER BY account_id').all(templatePostA.id).map((row) => row.account_id),
    ['tpl-tg', 'tpl-vk']
  );

  const templateV2Rich = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Версия 2', marks: [{ type: 'bold' }] }] }]
  };
  updateTemplate(template.id, { bodyRich: templateV2Rich });
  assert.equal(db.prepare('SELECT body FROM posts WHERE id=?').get(templatePostA.id).body, 'Версия 1');
  templatePreview = await preview(csv(templateRowV1), 'sheet-template');
  assert.equal(templatePreview.rows[0].classification, 'UNCHANGED', 'template edit must not reapply to existing imported Post');

  const templatePreviewB = await preview(csv({ ...templateRowV1, externalId: 'template-post-b', title: 'Template Post B' }), 'sheet-template');
  const templateCreateB = applyContentPlanV3(templatePreviewB, { actorSource: 'content_plan' });
  const templatePostB = db.prepare('SELECT body,body_rich_json FROM posts WHERE id=?').get(templateCreateB.postIds[0]);
  assert.equal(templatePostB.body, 'Версия 2');
  assert.equal(parseRichTextJson(templatePostB.body_rich_json).content[0].content[0].marks[0].type, 'bold');

  const explicitTemplatePreview = await preview(csv({
    externalId: 'template-explicit',
    templateKey: template.key,
    title: 'Template Explicit',
    body: '**Explicit body**',
    publicationKind: 'SHORT',
    contentFormat: 'VERTICAL_VIDEO',
    scheduleMode: 'MANUAL',
    timezone: '',
    targets: [{ accountId: 'tpl-max' }],
    revision: 'rev-1'
  }), 'sheet-template-explicit');
  assert.equal(explicitTemplatePreview.rows[0].classification, 'NEW');
  const explicitTemplateCreate = applyContentPlanV3(explicitTemplatePreview, { actorSource: 'content_plan' });
  const explicitTemplatePost = db.prepare('SELECT * FROM posts WHERE id=?').get(explicitTemplateCreate.postIds[0]);
  assert.equal(explicitTemplatePost.body, 'Explicit body');
  assert.equal(explicitTemplatePost.publication_kind, 'SHORT');
  assert.equal(explicitTemplatePost.content_format, 'VERTICAL_VIDEO');
  assert.deepEqual(
    db.prepare('SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1').all(explicitTemplatePost.id).map((row) => row.account_id),
    ['tpl-max']
  );

  const otherProjectId = 'prj-template-other';
  db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)')
    .run(otherProjectId, 'Other Template Project', 'template-other', new Date().toISOString());
  const otherTemplate = createTemplate({
    key: 'template-other-project',
    name: 'Other project template',
    projectId: otherProjectId,
    templateType: 'POST',
    bodyRich: templateV1Rich,
    publicationKind: 'FEED',
    contentFormat: 'IMAGE',
    scheduleMode: 'MANUAL'
  });
  const reusableTemplate = createTemplate({
    key: 'template-snippet-only',
    name: 'Snippet only',
    projectId: mainProject.id,
    templateType: 'SNIPPET',
    bodyRich: templateV1Rich
  });
  for (const [key, pattern] of [
    ['template-missing', /template not found/],
    [reusableTemplate.key, /is not POST/],
    [otherTemplate.key, /another project/]
  ]) {
    const invalidTemplate = await preview(csv({
      externalId: 'invalid-' + key,
      templateKey: key,
      body: '',
      publicationKind: '',
      contentFormat: '',
      scheduleMode: '',
      timezone: ''
    }), 'sheet-template-errors');
    assert.equal(invalidTemplate.rows[0].classification, 'ERROR');
    assert.match(invalidTemplate.rows[0].errors.join(' '), pattern);
  }

  const portableBody = '**Новый модуль**\n[Подробнее](https://example.org)\n> Важно';
  const portablePreview = await preview(csv({
    externalId: 'portable-rich-body',
    body: portableBody,
    publicationKind: 'FEED',
    contentFormat: 'TEXT_ONLY',
    targets: [{ accountId: 'tpl-max' }]
  }), 'sheet-portable');
  const portableCreate = applyContentPlanV3(portablePreview, { actorSource: 'content_plan' });
  const portablePost = db.prepare('SELECT body,body_rich_json FROM posts WHERE id=?').get(portableCreate.postIds[0]);
  const portableAst = parseRichTextJson(portablePost.body_rich_json);
  assert.ok(JSON.stringify(portableAst).includes('"type":"bold"'));
  assert.ok(JSON.stringify(portableAst).includes('"type":"link"'));
  assert.ok(JSON.stringify(portableAst).includes('"type":"blockquote"'));
  assert.equal(portablePost.body, richTextToPlain(portableAst));

  const overridePreview = await preview(csv({
    externalId: 'portable-rich-override',
    body: 'Base body',
    targets: [{ accountId: 'tpl-tg' }],
    telegramBody: '**TG bold**\n[Подробнее](https://example.org)\n> TG quote'
  }), 'sheet-portable-overrides');
  const overrideCreate = applyContentPlanV3(overridePreview, { actorSource: 'content_plan' });
  const overrideRow = db.prepare(`SELECT tr.text_rich_json,tr.text_plain
    FROM post_targets pt JOIN target_renditions tr ON tr.target_id=pt.id
    WHERE pt.post_id=? AND pt.account_id='tpl-tg'`).get(overrideCreate.postIds[0]);
  const overrideAst = parseRichTextJson(overrideRow.text_rich_json);
  assert.ok(JSON.stringify(overrideAst).includes('"type":"bold"'));
  assert.ok(JSON.stringify(overrideAst).includes('"type":"link"'));
  assert.ok(JSON.stringify(overrideAst).includes('"type":"blockquote"'));
  assert.equal(overrideRow.text_plain, richTextToPlain(overrideAst));

  const formatRows = [
    rowValues({ externalId: 'format-feed-text', body: 'Feed text', publicationKind: 'FEED', contentFormat: 'TEXT_ONLY' }),
    rowValues({ externalId: 'format-short-video', body: 'Short video', publicationKind: 'SHORT', contentFormat: 'VERTICAL_VIDEO' }),
    rowValues({ externalId: 'format-story-sequence', body: 'Story sequence', publicationKind: 'STORY', contentFormat: 'STORY_SEQUENCE' })
  ];
  const formatPreview = await preview(csvRows(formatRows), 'sheet-formats');
  assert.deepEqual(formatPreview.rows.map((row) => row.classification), ['NEW','NEW','NEW']);
  const formatCreate = applyContentPlanV3(formatPreview, { actorSource: 'content_plan' });
  const formatPosts = db.prepare(`SELECT publication_kind,content_format,status
    FROM posts WHERE id IN (?,?,?) ORDER BY publication_kind,content_format`)
    .all(...formatCreate.postIds);
  assert.equal(formatPosts.length, 3);
  assert.ok(formatPosts.every((row) => row.status === 'DRAFT'));
  assert.ok(formatPosts.some((row) => row.publication_kind === 'FEED' && row.content_format === 'TEXT_ONLY'));
  assert.ok(formatPosts.some((row) => row.publication_kind === 'SHORT' && row.content_format === 'VERTICAL_VIDEO'));
  assert.ok(formatPosts.some((row) => row.publication_kind === 'STORY' && row.content_format === 'STORY_SEQUENCE'));

  insertAccount('default-tg', 'Default TG', 'telegram');
  db.prepare('DELETE FROM project_default_targets WHERE project_id=?').run(mainProject.id);
  db.prepare('INSERT INTO project_default_targets (project_id,account_id,created_at) VALUES (?,?,?)')
    .run(mainProject.id, 'default-tg', new Date().toISOString());
  const defaultTargetPreview = await preview(csv({
    externalId: 'project-default-targets',
    body: 'Project targets',
    targets: []
  }), 'sheet-project-defaults');
  const defaultTargetCreate = applyContentPlanV3(defaultTargetPreview, { actorSource: 'content_plan' });
  assert.deepEqual(
    db.prepare('SELECT account_id FROM post_targets WHERE post_id=? AND enabled=1').all(defaultTargetCreate.postIds[0]).map((row) => row.account_id),
    ['default-tg']
  );

  db.prepare("UPDATE projects SET default_timezone='Europe/Moscow' WHERE id=?").run(mainProject.id);
  const timezonePreview = await preview(csv({
    externalId: 'project-default-timezone',
    body: 'Timezone fallback',
    scheduleMode: 'AT',
    scheduledAt: '2026-10-20T14:00',
    timezone: ''
  }), 'sheet-project-timezone');
  const timezoneCreate = applyContentPlanV3(timezonePreview, { actorSource: 'content_plan' });
  const timezonePost = db.prepare('SELECT scheduled_at_utc,schedule_timezone FROM posts WHERE id=?').get(timezoneCreate.postIds[0]);
  assert.equal(timezonePost.scheduled_at_utc, '2026-10-20T11:00:00.000Z');
  assert.equal(timezonePost.schedule_timezone, 'Europe/Moscow');

  let readyPreview = await preview(csv({
    externalId: 'ready-versioning',
    body: 'Ready v1',
    revision: 'rev-1'
  }), 'sheet-ready-versioning');
  const readyCreate = applyContentPlanV3(readyPreview, { actorSource: 'content_plan' });
  const readyId = readyCreate.postIds[0];
  const readyRevision = db.prepare('SELECT id FROM content_revisions WHERE post_id=? AND content_version=1').get(readyId);
  markReadyRevision(readyId, 1, readyRevision.id);
  readyPreview = await preview(csv({
    externalId: 'ready-versioning',
    body: 'Ready v2',
    revision: 'rev-2'
  }), 'sheet-ready-versioning');
  assert.equal(readyPreview.rows[0].classification, 'UPDATE');
  applyContentPlanV3(readyPreview, { actorSource: 'content_plan' });
  const readyAfter = db.prepare('SELECT status,editorial_stage,ready_revision_id,content_version FROM posts WHERE id=?').get(readyId);
  assert.equal(readyAfter.status, 'DRAFT');
  assert.equal(readyAfter.editorial_stage, 'DRAFT');
  assert.equal(readyAfter.ready_revision_id, null);
  assert.equal(readyAfter.content_version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_revisions WHERE post_id=?').get(readyId).n, 2);

  const seed100 = [
    ...Array.from({ length: 20 }, (_, i) => rowValues({ externalId: `batch-upd-${i}`, body: `seed upd ${i}`, revision: 'rev-1' })),
    ...Array.from({ length: 10 }, (_, i) => rowValues({ externalId: `batch-same-${i}`, body: `seed same ${i}`, revision: 'rev-1' })),
    ...Array.from({ length: 5 }, (_, i) => rowValues({ externalId: `batch-conflict-${i}`, body: `seed conflict ${i}`, revision: 'rev-1' })),
    ...Array.from({ length: 3 }, (_, i) => rowValues({ externalId: `batch-archive-${i}`, body: `seed archive ${i}`, revision: 'rev-1' }))
  ];
  const seed100Preview = await preview(csvRows(seed100), 'sheet-100');
  assert.equal(seed100Preview.summary.newRows, 38);
  applyContentPlanV3(seed100Preview, { actorSource: 'content_plan' });

  for (let i = 0; i < 5; i += 1) {
    const ref = JSON.stringify(['sheet-100', `batch-conflict-${i}`]);
    const existing = db.prepare("SELECT id,content_version FROM posts WHERE source_type='content-plan-v3' AND source_ref=?").get(ref);
    commitContentEdit(existing.id, existing.content_version, 'manual', () => {
      db.prepare('UPDATE posts SET body=? WHERE id=?').run(`local conflict ${i}`, existing.id);
    });
  }

  const final100Rows = [
    ...Array.from({ length: 60 }, (_, i) => rowValues({ externalId: `batch-new-${i}`, body: `new ${i}`, revision: 'rev-1' })),
    ...Array.from({ length: 20 }, (_, i) => rowValues({ externalId: `batch-upd-${i}`, body: `updated ${i}`, revision: 'rev-2' })),
    ...Array.from({ length: 10 }, (_, i) => rowValues({ externalId: `batch-same-${i}`, body: `seed same ${i}`, revision: 'rev-1' })),
    ...Array.from({ length: 5 }, (_, i) => rowValues({ externalId: `batch-conflict-${i}`, body: `sheet conflict ${i}`, revision: 'rev-2' })),
    ...Array.from({ length: 3 }, (_, i) => rowValues({ externalId: `batch-archive-${i}`, action: 'ARCHIVE', revision: 'rev-2' })),
    rowValues({ externalId: 'batch-error-project', project: 'missing-project', body: 'error', revision: 'rev-1' }),
    rowValues({ externalId: 'batch-error-body', body: '', templateKey: '', revision: 'rev-1' })
  ];
  const acceptance100 = await preview(csvRows(final100Rows), 'sheet-100');
  assert.equal(acceptance100.summary.totalRows, 100);
  assert.equal(acceptance100.summary.newRows, 60);
  assert.equal(acceptance100.summary.updateRows, 20);
  assert.equal(acceptance100.summary.unchangedRows, 10);
  assert.equal(acceptance100.summary.conflicts, 5);
  assert.equal(acceptance100.summary.requests, 3);
  assert.equal(acceptance100.summary.errors, 2);
  assert.equal(acceptance100.canApply, false);
  const acceptance100Repeat = await preview(csvRows(final100Rows), 'sheet-100');
  assert.deepEqual(acceptance100Repeat.summary, acceptance100.summary);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source_type='content-plan-v3' AND source_ref LIKE ?").get('%sheet-100%').n,
    38
  );

  const archiveSeed = await preview(csv({ externalId: 'archive-1', body: 'Archive me', revision: 'rev-1' }), 'sheet-actions');
  const archiveCreate = applyContentPlanV3(archiveSeed, { actorSource: 'content_plan' });
  const archiveId = archiveCreate.postIds[0];
  let archivePreview = await preview(csv({ externalId: 'archive-1', action: 'ARCHIVE', revision: 'rev-2' }), 'sheet-actions');
  assert.equal(archivePreview.rows[0].classification, 'ARCHIVE_REQUEST');
  assert.equal(archivePreview.canApply, true);
  applyContentPlanV3(archivePreview, { actorSource: 'content_plan' });
  let archiveRow = db.prepare('SELECT editorial_stage,content_version,imported_content_version FROM posts WHERE id=?').get(archiveId);
  assert.deepEqual(archiveRow, { editorial_stage: 'ARCHIVED', content_version: 2, imported_content_version: 2 });

  archivePreview = await preview(csv({ externalId: 'archive-1', action: 'ARCHIVE', revision: 'rev-2' }), 'sheet-actions');
  assert.equal(archivePreview.rows[0].classification, 'UNCHANGED');
  applyContentPlanV3(archivePreview, { actorSource: 'content_plan' });
  archiveRow = db.prepare('SELECT editorial_stage,content_version,imported_content_version FROM posts WHERE id=?').get(archiveId);
  assert.deepEqual(archiveRow, { editorial_stage: 'ARCHIVED', content_version: 2, imported_content_version: 2 });

  const immutableSeed = await preview(csv({ externalId: 'immutable-1', body: 'Published source', revision: 'rev-1' }), 'sheet-actions');
  const immutableCreate = applyContentPlanV3(immutableSeed, { actorSource: 'content_plan' });
  const immutableId = immutableCreate.postIds[0];
  db.prepare("UPDATE posts SET status='PUBLISHED' WHERE id=?").run(immutableId);
  const immutableArchive = await preview(csv({ externalId: 'immutable-1', action: 'ARCHIVE', revision: 'rev-2' }), 'sheet-actions');
  assert.equal(immutableArchive.rows[0].classification, 'ERROR');
  assert.equal(immutableArchive.canApply, false);
  assert.match(immutableArchive.rows[0].errors.join(' '), /status=PUBLISHED/);

  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'M0-003 / EW4-008',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    idempotent: true,
    sourcePayloadHash: true,
    sourceRevisionReuseRejected: true,
    update: true,
    conflict: true,
    sourceScopedIdentity: true,
    ambiguousAccountRejected: true,
    platformOverrideFanout: true,
    templateKey: true,
    templateSnapshotIsolation: true,
    templateExplicitOverride: true,
    portableRichBody: true,
    portableRichOverrides: true,
    canonicalPublicationKinds: true,
    canonicalContentFormats: true,
    projectTargetFallback: true,
    projectTimezoneFallback: true,
    updateVersioning: true,
    hundredRowAcceptance: true,
    previewApplyParity: true,
    v1Compatible: true,
    v2NotPublic: true
  }, null, 2));
} finally {
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
