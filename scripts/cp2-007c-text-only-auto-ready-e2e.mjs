import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-gs-text-ready-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = crypto.randomBytes(24).toString('hex');
process.env.APP_MASTER_KEY = crypto.randomBytes(40).toString('hex');
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8080';

try {
  const { db, migrate, id, nowIso } = await import('../dist/db.js');
  const { encryptJson } = await import('../dist/crypto.js');
  const { createDraftPost } = await import('../dist/post-creation.js');
  const { plainTextToRichText, serializeRichText } = await import('../dist/rich-text.js');
  const { autoReadyGoogleSheetsPost } = await import('../dist/google-sheets-auto-ready.js');

  migrate();
  let project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
  if (!project) {
    project = { id: id('prj') };
    db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)')
      .run(project.id, 'Test project', 'test-project', nowIso());
  }

  const accountId = id('acc');
  const now = nowIso();
  db.prepare(`INSERT INTO social_accounts
    (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`)
    .run(accountId, 'telegram', 'Local test destination',
      encryptJson({ botToken: 'local-fixture-token', chatId: '@local_fixture' }), now, now);

  const newPost = (contentFormat) => {
    const text = 'Пример текстового сообщения\\nВторая строка без изображения';
    const post = createDraftPost({
      projectId: project.id,
      title: contentFormat === 'TEXT_ONLY' ? 'Text-only imported post' : 'Image imported post',
      body: text,
      bodyRichJson: serializeRichText(plainTextToRichText(text)),
      scheduleMode: 'MANUAL',
      publicationKind: 'FEED',
      contentFormat,
      targetAccountIds: [accountId]
    });
    // Simulate a freshly imported second content revision; the initial draft is version one.
    db.prepare(`UPDATE posts
      SET source_type='google_sheets', content_version=2, imported_content_version=2
      WHERE id=?`).run(post.id);
    return post.id;
  };

  const textId = newPost('TEXT_ONLY');
  const textResult = autoReadyGoogleSheetsPost(textId);
  assert.equal(textResult.outcome, 'ready', JSON.stringify(textResult));
  const textPost = db.prepare('SELECT status,editorial_stage,ready_revision_id FROM posts WHERE id=?').get(textId);
  assert.equal(textPost.status, 'READY');
  assert.equal(textPost.editorial_stage, 'APPROVED');
  assert.ok(textPost.ready_revision_id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM media WHERE post_id=?').get(textId).n, 0);

  const imageId = newPost('IMAGE');
  const imageResult = autoReadyGoogleSheetsPost(imageId);
  assert.equal(imageResult.outcome, 'blocked');
  assert.match(imageResult.reason, /no media/);
  const imagePost = db.prepare('SELECT status,ready_revision_id FROM posts WHERE id=?').get(imageId);
  assert.equal(imagePost.status, 'DRAFT');
  assert.equal(imagePost.ready_revision_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM publication_events WHERE event_type LIKE ?')
    .get('%publish%').n, 0);

  db.close();
  console.log('CP2-007C TEXT_ONLY Auto Ready without media: PASS');
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}
