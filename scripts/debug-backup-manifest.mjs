import fs from 'node:fs/promises';
import path from 'node:path';

process.env.DATA_DIR = '/tmp/publikator-build-debug';
process.env.ADMIN_PASSWORD = 'debug';
process.env.APP_MASTER_KEY = 'x'.repeat(64);

await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });
await fs.mkdir(process.env.DATA_DIR, { recursive: true });

const sharp = (await import('sharp')).default;
const { db, migrate, id, nowIso } = await import('../dist/db.js');
const { saveImage } = await import('../dist/media.js');
const { createBackupBundle } = await import('../dist/backups.js');
const tar = await import('tar');

migrate();
const project = db.prepare('SELECT id FROM projects LIMIT 1').get();
const now = nowIso();
const firstPost = id('post');
const secondPost = id('post');
const insertPost = db.prepare('INSERT INTO posts (id,project_id,title,body,status,schedule_mode,scheduled_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
insertPost.run(firstPost, project.id, 'first', 'first', 'DRAFT', 'MANUAL', null, now, now);
insertPost.run(secondPost, project.id, 'second', 'second', 'DRAFT', 'MANUAL', null, now, now);

const white = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
const black = await sharp({ create: { width: 32, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
await saveImage(firstPost, 'white.png', white);
await saveImage(firstPost, 'black.png', black);
await saveImage(secondPost, 'white.png', white);

const dbCount = db.prepare('SELECT COUNT(*) AS count FROM media').get().count;
const userVersion = Number(db.pragma('user_version', { simple: true }));
const bundle = await createBackupBundle('debug-build');
const archivePath = path.join(process.env.DATA_DIR, 'backups', bundle.name);
const extractDir = '/tmp/publikator-build-debug-extract';
await fs.rm(extractDir, { recursive: true, force: true });
await fs.mkdir(extractDir, { recursive: true });
await tar.extract({ file: archivePath, cwd: extractDir });
const manifest = JSON.parse(await fs.readFile(path.join(extractDir, 'manifest.json'), 'utf8'));
console.log('BACKUP_DEBUG', JSON.stringify({ dbCount, userVersion, manifest }, null, 2));
if (dbCount !== 3 || userVersion !== 1 || manifest.schemaVersion !== 1 || manifest.counts.media !== 3 || manifest.mediaFiles.length !== 3) {
  throw new Error('Backup debug manifest mismatch');
}
db.close();
