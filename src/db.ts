import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { DATABASE_SCHEMA_VERSION } from './schema.js';

export { DATABASE_SCHEMA_VERSION } from './schema.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.mediaDir, { recursive: true });
fs.mkdirSync(config.backupDir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export type Platform = 'telegram' | 'vk' | 'max' | 'instagram';
export type PostStatus = 'DRAFT' | 'READY' | 'QUEUED' | 'PUBLISHING' | 'PARTIAL' | 'PUBLISHED' | 'FAILED';
export type TargetState = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'RETRY' | 'FAILED' | 'RECOVERY_NEEDED';

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function migrateMediaOrder(): void {
  const columns = db.prepare('PRAGMA table_info(media)').all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'sort_order')) return;

  db.exec('ALTER TABLE media ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  const rows = db.prepare('SELECT id,post_id FROM media ORDER BY post_id,created_at,rowid').all() as Array<{ id: string; post_id: string }>;
  const update = db.prepare('UPDATE media SET sort_order=? WHERE id=?');
  const nextByPost = new Map<string, number>();
  db.transaction(() => {
    for (const row of rows) {
      const order = nextByPost.get(row.post_id) ?? 0;
      update.run(order, row.id);
      nextByPost.set(row.post_id, order + 1);
    }
  })();
}

export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS social_accounts (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL CHECK(platform IN ('telegram','vk','max','instagram')),
      name TEXT NOT NULL,
      credentials_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','READY','QUEUED','PUBLISHING','PARTIAL','PUBLISHED','FAILED')),
      schedule_mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK(schedule_mode IN ('MANUAL','AT','QUEUE')),
      scheduled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS post_targets (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE RESTRICT,
      enabled INTEGER NOT NULL DEFAULT 1,
      override_text TEXT,
      state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PUBLISHING','PUBLISHED','RETRY','FAILED','RECOVERY_NEEDED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      external_id TEXT,
      external_url TEXT,
      last_error TEXT,
      published_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(post_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS schedule_slots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
      time_hhmm TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fired_on TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS publication_events (
      id TEXT PRIMARY KEY,
      post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES social_accounts(id) ON DELETE SET NULL,
      level TEXT NOT NULL CHECK(level IN ('info','warning','error')),
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  migrateMediaOrder();

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_posts_status_schedule ON posts(status, schedule_mode, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_targets_state_retry ON post_targets(state, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id);
    CREATE INDEX IF NOT EXISTS idx_media_post_order ON media(post_id, sort_order, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_created ON publication_events(created_at DESC);
  `);

  const projectCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number };
  if (projectCount.count === 0) {
    db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)')
      .run(id('prj'), 'Основной проект', 'main', nowIso());
  }

  db.prepare("UPDATE post_targets SET state='RECOVERY_NEEDED', last_error=COALESCE(last_error, 'Приложение было остановлено во время публикации. Требуется ручная проверка.'), updated_at=? WHERE state='PUBLISHING'")
    .run(nowIso());
  db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
}

export function event(params: {
  postId?: string | null;
  accountId?: string | null;
  level?: 'info' | 'warning' | 'error';
  type: string;
  message: string;
  data?: unknown;
}): void {
  db.prepare(`INSERT INTO publication_events
    (id, post_id, account_id, level, event_type, message, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id('evt'),
      params.postId ?? null,
      params.accountId ?? null,
      params.level ?? 'info',
      params.type,
      params.message,
      params.data === undefined ? null : JSON.stringify(params.data),
      nowIso()
    );
}
