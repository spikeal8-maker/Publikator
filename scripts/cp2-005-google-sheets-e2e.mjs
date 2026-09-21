import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cp2-005-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'cp2-005-acceptance-password';
process.env.APP_MASTER_KEY = 'cp2-005-master-key-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const serviceAccount = {
  type: 'service_account',
  client_email: 'publikator-test@test-project.iam.gserviceaccount.com',
  private_key: privateKeyPem,
  token_uri: 'https://oauth2.googleapis.com/token'
};

const header = [
  'schema_version', 'external_id', 'action', 'project', 'template_key', 'internal_title', 'body',
  'publication_kind', 'content_format', 'schedule_mode', 'scheduled_at', 'timezone', 'targets',
  'telegram_body', 'vk_body', 'max_body', 'instagram_body', 'media', 'tags', 'source_note', 'source_revision'
];
let sheetValues = [];
let writeBackFailure = false;
const writeBackBodies = [];
let metadataCalls = 0;
let valuesCalls = 0;
let tokenCalls = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') {
    tokenCalls += 1;
    assert.equal(init.method, 'POST');
    assert.match(String(init.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
    return new Response(JSON.stringify({ access_token: `token-${tokenCalls}`, expires_in: 3600, token_type: 'Bearer' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  assert.match(String(init.headers?.authorization ?? init.headers?.Authorization ?? ''), /^Bearer token-/);
  if (url.includes('?fields=properties.title,sheets.properties')) {
    metadataCalls += 1;
    return new Response(JSON.stringify({
      properties: { title: 'Publikator Test Sheet' },
      sheets: [{ properties: { sheetId: 0, title: 'Posts' } }, { properties: { sheetId: 1, title: 'Archive' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.endsWith('/values:batchUpdate')) {
    const body = JSON.parse(String(init.body));
    writeBackBodies.push(body);
    if (writeBackFailure) return new Response(JSON.stringify({ error: { message: 'write blocked' } }), { status: 403, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ totalUpdatedCells: body.data.length * 4 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/values/')) {
    valuesCalls += 1;
    return new Response(JSON.stringify({ range: "'Posts'!A1:U10001", majorDimension: 'ROWS', values: sheetValues }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  throw new Error(`Unexpected Google request: ${url}`);
};

try {
  const { db, id, migrate, nowIso } = await import('../dist/db.js');
  const { commitContentEdit } = await import('../dist/content-versioning.js');
  const { buildApp } = await import('../dist/app.js');
  const { createTemplate } = await import('../dist/templates.js');
  const { parseRichTextJson } = await import('../dist/rich-text.js');
  migrate();
  let project = db.prepare('SELECT id,slug FROM projects ORDER BY created_at LIMIT 1').get();
  if (!project) {
    project = { id: id('prj'), slug: 'main' };
    db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)').run(project.id, 'Main', project.slug, nowIso());
  }

  const row = (externalId, title, body, revision, options = {}) => [
    '3', externalId, options.action ?? 'UPSERT', project.slug, options.templateKey ?? '', title, body,
    options.publicationKind ?? 'FEED', options.contentFormat ?? 'IMAGE', options.scheduleMode ?? 'MANUAL',
    options.scheduledAt ?? '', options.timezone ?? 'UTC', options.targets ?? '[]',
    options.telegramBody ?? '', options.vkBody ?? '', options.maxBody ?? '', options.instagramBody ?? '',
    '', '', '', revision
  ];
  const sheetTemplate = createTemplate({
    key: 'google-sheet-template-v3',
    name: 'Google Sheet template v3',
    projectId: project.id,
    templateType: 'POST',
    bodyRich: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Template body', marks: [{ type: 'bold' }] }] }]
    },
    publicationKind: 'FEED',
    contentFormat: 'IMAGE',
    scheduleMode: 'QUEUE'
  });
  sheetValues = [header, row('sheet-001', 'From Google', 'Body v1', 'rev-1')];

  const app = await buildApp();
  await app.ready();
  const anonymous = await app.inject({ method: 'GET', url: '/api/google-sheets/connectors' });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const request = (method, url, payload) => app.inject({
    method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload })
  });

  const inspect = await request('POST', '/api/google-sheets/inspect', { spreadsheetId: 'spreadsheet_test_12345', credentials: serviceAccount });
  assert.equal(inspect.statusCode, 200, inspect.body);
  assert.deepEqual(inspect.json().sheets, ['Posts', 'Archive']);
  assert.equal(inspect.json().serviceAccountEmail, serviceAccount.client_email);

  const create = await request('POST', '/api/google-sheets/connectors', {
    name: 'Editorial Sheet', spreadsheetId: 'spreadsheet_test_12345', sheetName: 'Posts', writeBack: true, credentials: serviceAccount
  });
  assert.equal(create.statusCode, 201, create.body);
  const connector = create.json().connector;
  assert.equal(connector.type, 'google_sheets');
  assert.equal(connector.config.sheetName, 'Posts');
  assert.equal(connector.config.serviceAccountEmail, serviceAccount.client_email);
  const stored = db.prepare('SELECT config_json,credentials_encrypted FROM ingestion_connectors WHERE id=?').get(connector.id);
  assert.ok(stored.credentials_encrypted.startsWith('v1:'));
  assert.ok(!stored.credentials_encrypted.includes('BEGIN PRIVATE KEY'));
  assert.ok(!stored.config_json.includes('private_key'));

  const connectors = await request('GET', '/api/google-sheets/connectors');
  assert.equal(connectors.statusCode, 200, connectors.body);
  assert.equal(connectors.json().connectors.length, 1);
  assert.equal(JSON.stringify(connectors.json()).includes('private_key'), false);

  const preview1 = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(preview1.statusCode, 200, preview1.body);
  assert.equal(preview1.json().summary.newRows, 1);
  assert.equal(preview1.json().canApply, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 0, 'preview must not mutate posts');
  const staleSha = preview1.json().sourceSnapshotSha256;

  sheetValues = [header, row('sheet-001', 'From Google', 'Body changed before apply', 'rev-2')];
  const staleApply = await request('POST', `/api/google-sheets/connectors/${connector.id}/apply`, { confirm: 'IMPORT', previewSha: staleSha });
  assert.equal(staleApply.statusCode, 409, staleApply.body);
  assert.match(staleApply.json().error, /changed after preview/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 0);

  const preview2 = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(preview2.statusCode, 200, preview2.body);
  assert.equal(preview2.json().summary.newRows, 1);
  const apply1 = await request('POST', `/api/google-sheets/connectors/${connector.id}/apply`, { confirm: 'IMPORT', previewSha: preview2.json().sourceSnapshotSha256 });
  assert.equal(apply1.statusCode, 200, apply1.body);
  assert.equal(apply1.json().created, 1);
  assert.equal(apply1.json().writeBack.ok, true);
  let post = db.prepare("SELECT * FROM posts WHERE source_type='google_sheets'").get();
  assert.ok(post);
  assert.equal(post.status, 'DRAFT');
  assert.equal(post.editorial_stage, 'DRAFT');
  assert.equal(post.body, 'Body changed before apply');
  assert.deepEqual(JSON.parse(post.source_ref), [`gs:${connector.id}`, 'sheet-001']);
  assert.equal(post.source_revision, 'rev-2');
  assert.deepEqual(
    db.prepare('SELECT content_version,actor_source FROM content_revisions WHERE post_id=? ORDER BY content_version').all(post.id),
    [{ content_version: 1, actor_source: 'google_sheets' }]
  );
  assert.ok(writeBackBodies.at(-1).data.some((item) => item.range.includes('V1:Y1')));
  assert.ok(writeBackBodies.at(-1).data.some((item) => item.range.includes('V2:Y2')));

  const unchanged = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  assert.equal(unchanged.json().summary.unchangedRows, 1);

  sheetValues = [header, row('sheet-001', 'From Google', 'Body v3', 'rev-3')];
  const updatePreview = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(updatePreview.json().summary.updateRows, 1);
  const updateApply = await request('POST', `/api/google-sheets/connectors/${connector.id}/apply`, { confirm: 'IMPORT', previewSha: updatePreview.json().sourceSnapshotSha256 });
  assert.equal(updateApply.statusCode, 200, updateApply.body);
  assert.equal(updateApply.json().updated, 1);
  post = db.prepare('SELECT * FROM posts WHERE id=?').get(post.id);
  assert.equal(post.body, 'Body v3');
  assert.deepEqual(
    db.prepare('SELECT content_version,actor_source FROM content_revisions WHERE post_id=? ORDER BY content_version').all(post.id),
    [
      { content_version: 1, actor_source: 'google_sheets' },
      { content_version: 2, actor_source: 'google_sheets' }
    ]
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 1, 'update must not duplicate');

  writeBackFailure = true;
  sheetValues = [
    header,
    row('sheet-001', 'From Google', 'Body v3', 'rev-3'),
    row('sheet-002', 'Second Google row', 'Second body', 'rev-1')
  ];
  const secondPreview = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(secondPreview.json().summary.newRows, 1);
  const secondApply = await request('POST', `/api/google-sheets/connectors/${connector.id}/apply`, { confirm: 'IMPORT', previewSha: secondPreview.json().sourceSnapshotSha256 });
  assert.equal(secondApply.statusCode, 200, secondApply.body);
  assert.equal(secondApply.json().created, 1);
  assert.equal(secondApply.json().writeBack.attempted, true);
  assert.equal(secondApply.json().writeBack.ok, false, 'write-back failure must not roll back canonical import');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 2);
  writeBackFailure = false;

  sheetValues = [header, row(
    'sheet-editorial-v3',
    'Editorial Sheet v3',
    '**Новый модуль**\n[Подробнее](https://example.org)\n> Важно',
    'rev-1',
    {
      templateKey: sheetTemplate.key,
      publicationKind: 'STORY',
      contentFormat: 'STORY_SEQUENCE',
      scheduleMode: '',
      timezone: ''
    }
  )];
  const editorialV3Preview = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(editorialV3Preview.statusCode, 200, editorialV3Preview.body);
  assert.equal(editorialV3Preview.json().summary.newRows, 1);
  assert.equal(editorialV3Preview.json().canApply, true);
  const normalizedV3 = editorialV3Preview.json().rows[0].normalized;
  assert.equal(normalizedV3.templateKey, sheetTemplate.key);
  assert.equal(normalizedV3.publicationKind, 'STORY');
  assert.equal(normalizedV3.contentFormat, 'STORY_SEQUENCE');
  assert.equal(normalizedV3.scheduleMode, 'QUEUE');

  const editorialV3Apply = await request('POST', `/api/google-sheets/connectors/${connector.id}/apply`, {
    confirm: 'IMPORT',
    previewSha: editorialV3Preview.json().sourceSnapshotSha256
  });
  assert.equal(editorialV3Apply.statusCode, 200, editorialV3Apply.body);
  assert.equal(editorialV3Apply.json().created, 1);
  const editorialV3Post = db.prepare("SELECT * FROM posts WHERE source_type='google_sheets' AND source_ref=?")
    .get(JSON.stringify([`gs:${connector.id}`, 'sheet-editorial-v3']));
  assert.ok(editorialV3Post);
  assert.equal(editorialV3Post.status, 'DRAFT');
  assert.equal(editorialV3Post.publication_kind, 'STORY');
  assert.equal(editorialV3Post.content_format, 'STORY_SEQUENCE');
  assert.equal(editorialV3Post.schedule_mode, 'QUEUE');
  const editorialV3Ast = parseRichTextJson(editorialV3Post.body_rich_json);
  assert.ok(JSON.stringify(editorialV3Ast).includes('"type":"bold"'));
  assert.ok(JSON.stringify(editorialV3Ast).includes('"type":"link"'));
  assert.ok(JSON.stringify(editorialV3Ast).includes('"type":"blockquote"'));


  commitContentEdit(post.id, post.content_version, 'manual', () => {
    db.prepare('UPDATE posts SET body=? WHERE id=?').run('Manual local edit', post.id);
  });
  sheetValues = [header, row('sheet-001', 'From Google', 'Body from Sheet after local edit', 'rev-4')];
  const conflict = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(conflict.statusCode, 200, conflict.body);
  assert.equal(conflict.json().summary.conflicts, 1);
  assert.equal(conflict.json().canApply, false);
  const conflictSha = conflict.json().sourceSnapshotSha256;

  const compared = await request('POST', `/api/google-sheets/connectors/${connector.id}/conflicts/resolve`, {
    externalId: 'sheet-001', resolution: 'COMPARE', previewSha: conflictSha
  });
  assert.equal(compared.statusCode, 200, compared.body);
  assert.equal(compared.json().local.body, 'Manual local edit');
  assert.equal(compared.json().sheet.body, 'Body from Sheet after local edit');

  sheetValues = [header, row('sheet-001', 'From Google', 'Sheet changed after conflict preview', 'rev-5')];
  const staleConflictResolution = await request('POST', `/api/google-sheets/connectors/${connector.id}/conflicts/resolve`, {
    externalId: 'sheet-001', resolution: 'KEEP_PUBLIKATOR', previewSha: conflictSha
  });
  assert.equal(staleConflictResolution.statusCode, 409, staleConflictResolution.body);
  assert.match(staleConflictResolution.json().error, /changed after preview/i);

  sheetValues = [header, row('sheet-001', 'From Google', 'Body from Sheet after local edit', 'rev-4')];
  const conflictFresh = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  const kept = await request('POST', `/api/google-sheets/connectors/${connector.id}/conflicts/resolve`, {
    externalId: 'sheet-001', resolution: 'KEEP_PUBLIKATOR', previewSha: conflictFresh.json().sourceSnapshotSha256
  });
  assert.equal(kept.statusCode, 200, kept.body);
  assert.equal(db.prepare('SELECT body FROM posts WHERE id=?').get(post.id).body, 'Manual local edit');
  const afterKeep = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(afterKeep.json().summary.unchangedRows, 1);

  const keptVersion = db.prepare('SELECT content_version FROM posts WHERE id=?').get(post.id).content_version;
  commitContentEdit(post.id, keptVersion, 'manual', () => {
    db.prepare('UPDATE posts SET body=? WHERE id=?').run('Second manual local edit', post.id);
  });
  sheetValues = [header, row('sheet-001', 'From Google', 'Sheet wins explicitly', 'rev-5')];
  const useConflict = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(useConflict.json().summary.conflicts, 1);
  const used = await request('POST', `/api/google-sheets/connectors/${connector.id}/conflicts/resolve`, {
    externalId: 'sheet-001', resolution: 'USE_SHEET', previewSha: useConflict.json().sourceSnapshotSha256
  });
  assert.equal(used.statusCode, 200, used.body);
  assert.equal(db.prepare('SELECT body FROM posts WHERE id=?').get(post.id).body, 'Sheet wins explicitly');
  assert.ok(db.prepare('SELECT content_version FROM posts WHERE id=?').get(post.id).content_version > keptVersion);
  assert.ok(db.prepare("SELECT COUNT(*) AS count FROM publication_events WHERE post_id=? AND event_type='sheet.sync_conflict'").get(post.id).count >= 2);

  sheetValues = [header];
  const deletedRowPreview = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(deletedRowPreview.statusCode, 400, deletedRowPreview.body);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts WHERE source_type='google_sheets'").get().count, 3, 'removing a Sheet row must never delete a post');

  sheetValues = [
    header,
    row('sheet-001', '', '', 'rev-6', { action: 'ARCHIVE', scheduleMode: '', timezone: '' }),
    row('sheet-002', '', '', 'rev-2', { action: 'TRASH_REQUEST', scheduleMode: '', timezone: '' })
  ];
  const lifecyclePreview = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(lifecyclePreview.statusCode, 200, lifecyclePreview.body);
  assert.equal(lifecyclePreview.json().summary.requests, 2);
  assert.deepEqual(lifecyclePreview.json().rows.map((item) => item.classification), ['ARCHIVE_REQUEST','TRASH_REQUEST']);
  assert.equal(lifecyclePreview.json().canApply, true);

  const lifecycleApply = await request('POST', `/api/google-sheets/connectors/${connector.id}/apply`, {
    confirm: 'IMPORT',
    previewSha: lifecyclePreview.json().sourceSnapshotSha256
  });
  assert.equal(lifecycleApply.statusCode, 200, lifecycleApply.body);
  assert.equal(lifecycleApply.json().archived, 1);
  assert.equal(lifecycleApply.json().trashed, 1);
  assert.deepEqual(
    db.prepare('SELECT editorial_stage,status FROM posts WHERE id=?').get(post.id),
    { editorial_stage: 'ARCHIVED', status: 'DRAFT' }
  );
  const sheet2 = db.prepare("SELECT id,editorial_stage,status FROM posts WHERE source_type='google_sheets' AND source_ref=?")
    .get(JSON.stringify([`gs:${connector.id}`, 'sheet-002']));
  assert.deepEqual(
    { editorial_stage: sheet2.editorial_stage, status: sheet2.status },
    { editorial_stage: 'TRASHED', status: 'DRAFT' }
  );

  const lifecycleUnchanged = await request('POST', `/api/google-sheets/connectors/${connector.id}/preview`, {});
  assert.equal(lifecycleUnchanged.statusCode, 200, lifecycleUnchanged.body);
  assert.equal(lifecycleUnchanged.json().summary.unchangedRows, 2);

  assert.ok(metadataCalls >= 2);
  assert.ok(valuesCalls >= 6);

  const ui = await fs.readFile(path.join(process.cwd(), 'public', 'google-sheets-v1.js'), 'utf8');
  const index = await fs.readFile(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  assert.match(ui, /Посмотреть изменения/);
  assert.match(ui, /Service Account JSON/);
  assert.match(ui, /Импортировать изменения/);
  assert.match(ui, /row deletion never deletes|Удаление строк/i);
  assert.match(ui, /Оставить Publikator/);
  assert.match(ui, /Использовать Sheet/);
  assert.match(ui, /Сравнить/);
  assert.match(index, /google-sheets-v1\.js/);

  await app.close();
  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'CP2-005 / EW4-008',
    connector: true,
    templateKey: true,
    portableRichText: true,
    publicationKind: true,
    contentFormat: true,
    sharedEditorialContract: true,
    conflictCompare: true,
    conflictKeepPublikator: true,
    conflictUseSheet: true,
    staleConflictSnapshotBlocked: true,
    explicitArchiveRequest: true,
    explicitTrashRequest: true,
    rowDeletionStillNoDelete: true,
    writeBackPreserved: true
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
