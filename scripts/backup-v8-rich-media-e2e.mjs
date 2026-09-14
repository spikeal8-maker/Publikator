import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-backup-v8-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'backup-v8-ci-password';
process.env.APP_MASTER_KEY = 'backup-v8-master-key-that-is-longer-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { config } = await import('../dist/config.js');
const rich = await import('../dist/rich-media.js');
const { snapshotContentRevision } = await import('../dist/content-versioning.js');
const { createBackupBundle, resolveBackupBundle, stageRestoreBundle } = await import('../dist/backups.js');
const { applyPendingRestore } = await import('../dist/restore-bootstrap.js');

migrate();
const projectId = id('prj');
const projectNow = nowIso();
db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)')
  .run(projectId, 'Backup v8 project', 'backup-v8-project', projectNow);
const postId = id('post');
const now = nowIso();
db.prepare(`INSERT INTO posts
  (id,project_id,title,body,status,editorial_stage,schedule_mode,content_version,created_at,updated_at,publication_kind,content_format)
  VALUES (?,?,?,?,'DRAFT','DRAFT','MANUAL',1,?,?,'FEED','IMAGE')`)
  .run(postId, projectId, 'Backup rich media', 'Body', now, now);
await fs.mkdir(path.join(config.mediaDir, postId), { recursive: true });
function insertMedia(mediaId, name, mimeType, width, height, order, bytes) {
  const relativePath = `${postId}/${name}`;
  db.prepare(`INSERT INTO media
    (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mediaId, postId, name, relativePath, mimeType, bytes.length, width, height,
      Buffer.from(bytes).toString('hex').padEnd(64, '0').slice(0, 64), nowIso(), order);
  return fs.writeFile(path.join(config.mediaDir, relativePath), bytes);
}
const videoId = id('med');
const posterId = id('med');
await insertMedia(videoId, 'clip.mp4', 'video/mp4', 1080, 1920, 0, Buffer.from('video-fixture'));
await insertMedia(posterId, 'poster.jpg', 'image/jpeg', 1080, 1920, 1, Buffer.from('poster-fixture'));
const metadata = rich.setVideoMetadataVersioned(videoId, 1, {
  durationMs: 9876, fps: 29.97, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4', posterAssetId: posterId
});
const composition = rich.setContentCompositionVersioned(postId, metadata.contentVersion, 'SHORT', 'VERTICAL_VIDEO', [
  { mediaId: videoId, role: 'video' }, { mediaId: posterId, role: 'poster' }
]);
const revision = snapshotContentRevision(postId, composition.contentVersion, 'backup-v8');
const postBefore = db.prepare('SELECT publication_kind,content_format,content_version FROM posts WHERE id=?').get(postId);
const mediaBefore = db.prepare(`SELECT id,duration_ms,fps,video_codec,audio_codec,container,poster_asset_id
  FROM media WHERE post_id=? ORDER BY sort_order`).all(postId);
const relationBefore = db.prepare('SELECT * FROM content_media WHERE post_id=? ORDER BY sort_order').all(postId);
const revisionBefore = db.prepare('SELECT media_json,content_media_json FROM content_revisions WHERE id=?').get(revision.id);

const bundle = await createBackupBundle('schema8-rich-media');
const bundlePath = resolveBackupBundle(bundle.name);
assert.ok((await fs.stat(bundlePath)).size > 0);

db.prepare('UPDATE media SET duration_ms=1,poster_asset_id=NULL WHERE id=?').run(videoId);
db.prepare('DELETE FROM content_media WHERE post_id=?').run(postId);
db.prepare("UPDATE content_revisions SET content_media_json='[]' WHERE id=?").run(revision.id);
const staged = await stageRestoreBundle(bundlePath);
assert.equal(staged.manifest.schemaVersion, 8);
db.close();
const applied = await applyPendingRestore();
assert.equal(applied.applied, true);

const restored = new Database(config.dbPath, { readonly: true, fileMustExist: true });
try {
  assert.equal(Number(restored.pragma('user_version', { simple: true })), 8);
  assert.deepEqual(restored.prepare('SELECT publication_kind,content_format,content_version FROM posts WHERE id=?').get(postId), postBefore);
  assert.deepEqual(restored.prepare(`SELECT id,duration_ms,fps,video_codec,audio_codec,container,poster_asset_id
    FROM media WHERE post_id=? ORDER BY sort_order`).all(postId), mediaBefore);
  assert.deepEqual(restored.prepare('SELECT * FROM content_media WHERE post_id=? ORDER BY sort_order').all(postId), relationBefore);
  assert.deepEqual(restored.prepare('SELECT media_json,content_media_json FROM content_revisions WHERE id=?').get(revision.id), revisionBefore);
  assert.equal((await fs.readFile(path.join(config.mediaDir, postId, 'clip.mp4'))).toString(), 'video-fixture');
  assert.equal((await fs.readFile(path.join(config.mediaDir, postId, 'poster.jpg'))).toString(), 'poster-fixture');
  console.log(JSON.stringify({
    ok: true,
    schemaVersion: 8,
    videoMetadataPreserved: true,
    contentMediaPreserved: true,
    immutableRelationSnapshotPreserved: true,
    mediaFilesPreserved: true,
    pendingRestoreApplied: true
  }, null, 2));
} finally {
  restored.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
