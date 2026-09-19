import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { DATABASE_SCHEMA_VERSION } from './schema.js';
import { migrateRichMediaModel } from './rich-media-migration.js';
import { migrateRevisionHistory } from './revision-history-migration.js';
import { migrateCanonicalRichText } from './canonical-rich-text-migration.js';
import { canonicalPlainRichJson } from './rich-text.js';

export { DATABASE_SCHEMA_VERSION } from './schema.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.mediaDir, { recursive: true });
fs.mkdirSync(config.backupDir, { recursive: true });

export const db = new Database(config.dbPath);
db.function('publikator_plain_rich_json', { deterministic: true }, (value: unknown) => canonicalPlainRichJson(String(value ?? '')));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export type Platform = 'telegram' | 'vk' | 'max' | 'instagram';
export type PostStatus = 'DRAFT' | 'READY' | 'QUEUED' | 'PUBLISHING' | 'PARTIAL' | 'PUBLISHED' | 'FAILED';
export type EditorialStage = 'IDEA' | 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'ARCHIVED' | 'TRASHED';
export type TargetState = 'PENDING' | 'PUBLISHING' | 'PARTIAL' | 'PUBLISHED' | 'RETRY' | 'FAILED' | 'RECOVERY_NEEDED';

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

function migrateUniqueScheduleSlots(): void {
  const rows = db.prepare(`SELECT rowid,id,project_id,weekday,time_hhmm,timezone,last_fired_on
    FROM schedule_slots
    ORDER BY project_id,weekday,time_hhmm,timezone,created_at,rowid`).all() as Array<{
      rowid: number;
      id: string;
      project_id: string;
      weekday: number;
      time_hhmm: string;
      timezone: string;
      last_fired_on: string | null;
    }>;

  const seen = new Map<string, { id: string; lastFiredOn: string | null }>();
  const updateKeeper = db.prepare('UPDATE schedule_slots SET last_fired_on=? WHERE id=?');
  const removeDuplicate = db.prepare('DELETE FROM schedule_slots WHERE id=?');

  db.transaction(() => {
    for (const row of rows) {
      const key = `${row.project_id}\u0000${row.weekday}\u0000${row.time_hhmm}\u0000${row.timezone}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, { id: row.id, lastFiredOn: row.last_fired_on });
        continue;
      }

      const mergedLastFiredOn = [existing.lastFiredOn, row.last_fired_on]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
      if (mergedLastFiredOn !== existing.lastFiredOn) {
        updateKeeper.run(mergedLastFiredOn, existing.id);
        existing.lastFiredOn = mergedLastFiredOn;
      }
      removeDuplicate.run(row.id);
    }
  })();
}

function migrateContentVersioning(): void {
  const columns = new Set((db.prepare('PRAGMA table_info(posts)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has('editorial_stage')) {
    db.exec("ALTER TABLE posts ADD COLUMN editorial_stage TEXT NOT NULL DEFAULT 'DRAFT' CHECK(editorial_stage IN ('IDEA','DRAFT','IN_REVIEW','APPROVED','ARCHIVED','TRASHED'))");
  }
  if (!columns.has('content_version')) {
    db.exec('ALTER TABLE posts ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1 CHECK(content_version >= 1)');
  }
  if (!columns.has('ready_revision_id')) {
    db.exec('ALTER TABLE posts ADD COLUMN ready_revision_id TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS content_revisions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      content_version INTEGER NOT NULL CHECK(content_version >= 1),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      schedule_mode TEXT NOT NULL CHECK(schedule_mode IN ('MANUAL','AT','QUEUE')),
      scheduled_at TEXT,
      targets_json TEXT NOT NULL,
      media_json TEXT NOT NULL,
      actor_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(post_id, content_version)
    )
  `);

  db.prepare("UPDATE posts SET status='READY' WHERE status='QUEUED' AND schedule_mode='QUEUE'").run();
  db.prepare(`UPDATE posts SET editorial_stage=CASE
      WHEN status IN ('READY','PUBLISHED') THEN 'APPROVED'
      ELSE 'DRAFT' END,
      content_version=CASE WHEN content_version < 1 THEN 1 ELSE content_version END`).run();

  const snapshotPosts = db.prepare(`SELECT id,title,body,schedule_mode,scheduled_at,content_version
    FROM posts WHERE status IN ('READY','PUBLISHED','PARTIAL','PUBLISHING') AND ready_revision_id IS NULL ORDER BY created_at,id`).all() as Array<{
      id: string; title: string; body: string; schedule_mode: string; scheduled_at: string | null; content_version: number;
    }>;
  const targets = db.prepare(`SELECT id AS targetId,account_id AS accountId,enabled,override_text AS overrideText
    FROM post_targets WHERE post_id=? ORDER BY rowid`);
  const media = db.prepare('SELECT * FROM media WHERE post_id=? ORDER BY sort_order,created_at');
  const insertRevision = db.prepare(`INSERT OR IGNORE INTO content_revisions
    (id,post_id,content_version,title,body,schedule_mode,scheduled_at,targets_json,media_json,actor_source,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const setReadyRevision = db.prepare('UPDATE posts SET ready_revision_id=? WHERE id=? AND ready_revision_id IS NULL');

  db.transaction(() => {
    for (const post of snapshotPosts) {
      const revisionId = id('rev');
      const targetSnapshot = (targets.all(post.id) as Array<{ targetId: string; accountId: string; enabled: number; overrideText: string | null }>).map((target) => ({
        targetId: target.targetId,
        accountId: target.accountId,
        enabled: Boolean(target.enabled),
        overrideText: target.overrideText
      }));
      const mediaSnapshot = media.all(post.id);
      insertRevision.run(
        revisionId, post.id, post.content_version, post.title, post.body, post.schedule_mode, post.scheduled_at,
        JSON.stringify(targetSnapshot), JSON.stringify(mediaSnapshot), 'migration-v3-v4', nowIso()
      );
      const stored = db.prepare('SELECT id FROM content_revisions WHERE post_id=? AND content_version=?')
        .get(post.id, post.content_version) as { id: string };
      setReadyRevision.run(stored.id, post.id);
    }
  })();
}

function migrateIngestionProvenance(): void {
  const columns = new Set((db.prepare('PRAGMA table_info(posts)').all() as Array<{ name: string }>).map((column) => column.name));
  const additions = [
    ['source_type', 'TEXT'],
    ['source_ref', 'TEXT'],
    ['source_revision', 'TEXT'],
    ['source_payload_hash', 'TEXT'],
    ['source_batch_id', 'TEXT'],
    ['imported_at', 'TEXT'],
    ['imported_content_version', 'INTEGER']
  ] as const;
  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE posts ADD COLUMN ${name} ${type}`);
  }
}

function migrateIngestionSecurity(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_api_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL, last_used_at TEXT,
      rotated_from_id TEXT REFERENCES integration_api_keys(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS ingestion_connectors (
      id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('google_sheets','google_drive','yandex_disk','generic_https')),
      name TEXT NOT NULL, config_json TEXT NOT NULL, credentials_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
}

function migrateTimeRenditionSequence(): void {
  const postColumns = new Set((db.prepare('PRAGMA table_info(posts)').all() as Array<{ name: string }>).map((row) => row.name));
  for (const [name, type] of [
    ['scheduled_at_utc', 'TEXT'], ['schedule_timezone', 'TEXT'],
    ['publication_kind', "TEXT NOT NULL DEFAULT 'FEED' CHECK(publication_kind IN ('FEED','SHORT','STORY'))"], ['content_format', "TEXT NOT NULL DEFAULT 'IMAGE' CHECK(content_format IN ('TEXT_ONLY','IMAGE','CAROUSEL','VIDEO','VERTICAL_VIDEO','STORY_SEQUENCE'))"]
  ] as const) if (!postColumns.has(name)) db.exec(`ALTER TABLE posts ADD COLUMN ${name} ${type}`);
  const revisionColumns = new Set((db.prepare('PRAGMA table_info(content_revisions)').all() as Array<{ name: string }>).map((row) => row.name));
  for (const [name, type] of [
    ['scheduled_at_utc', 'TEXT'], ['schedule_timezone', 'TEXT'],
    ['publication_kind', "TEXT NOT NULL DEFAULT 'FEED' CHECK(publication_kind IN ('FEED','SHORT','STORY'))"], ['content_format', "TEXT NOT NULL DEFAULT 'IMAGE' CHECK(content_format IN ('TEXT_ONLY','IMAGE','CAROUSEL','VIDEO','VERTICAL_VIDEO','STORY_SEQUENCE'))"]
  ] as const) if (!revisionColumns.has(name)) db.exec(`ALTER TABLE content_revisions ADD COLUMN ${name} ${type}`);

  db.prepare("UPDATE posts SET scheduled_at_utc=scheduled_at,schedule_timezone='UTC' WHERE schedule_mode='AT' AND scheduled_at IS NOT NULL AND scheduled_at_utc IS NULL").run();
  db.prepare("UPDATE content_revisions SET scheduled_at_utc=scheduled_at,schedule_timezone='UTC' WHERE schedule_mode='AT' AND scheduled_at IS NOT NULL AND scheduled_at_utc IS NULL").run();
  db.prepare("UPDATE posts SET publication_kind='FEED',content_format=CASE WHEN (SELECT COUNT(*) FROM media WHERE media.post_id=posts.id)>1 THEN 'CAROUSEL' ELSE 'IMAGE' END").run();
  const revisions = db.prepare('SELECT id,media_json FROM content_revisions').all() as Array<{ id: string; media_json: string }>;
  const updateRevisionFormat = db.prepare("UPDATE content_revisions SET publication_kind='FEED',content_format=? WHERE id=?");
  for (const revision of revisions) {
    let count = 0;
    try { const media = JSON.parse(revision.media_json); count = Array.isArray(media) ? media.length : 0; } catch { count = 0; }
    updateRevisionFormat.run(count > 1 ? 'CAROUSEL' : 'IMAGE', revision.id);
  }
  const revisionTargets = db.prepare('SELECT id,targets_json FROM content_revisions').all() as Array<{ id: string; targets_json: string }>;
  const updateRevisionTargets = db.prepare('UPDATE content_revisions SET targets_json=? WHERE id=?');
  for (const revision of revisionTargets) {
    try {
      const targets = JSON.parse(revision.targets_json);
      if (!Array.isArray(targets)) continue;
      const normalized = targets.map((target) => target && typeof target === 'object' && !Array.isArray(target)
        ? { ...target, rendition: Object.prototype.hasOwnProperty.call(target, 'rendition') ? target.rendition : null } : target);
      updateRevisionTargets.run(JSON.stringify(normalized), revision.id);
    } catch { /* historical corrupt snapshot remains visible to existing invariant checks */ }
  }

  const targetSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='post_targets'").get() as { sql?: string } | undefined)?.sql ?? '');
  if (!targetSql.includes("'PARTIAL'")) {
    db.exec(`ALTER TABLE post_targets RENAME TO post_targets_v6;
      CREATE TABLE post_targets (
        id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE RESTRICT, enabled INTEGER NOT NULL DEFAULT 1,
        override_text TEXT, state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PUBLISHING','PARTIAL','PUBLISHED','RETRY','FAILED','RECOVERY_NEEDED')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, external_id TEXT, external_url TEXT,
        last_error TEXT, published_at TEXT, updated_at TEXT NOT NULL, UNIQUE(post_id, account_id));
      INSERT INTO post_targets SELECT * FROM post_targets_v6; DROP TABLE post_targets_v6;`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS target_renditions (
      target_id TEXT PRIMARY KEY REFERENCES post_targets(id) ON DELETE CASCADE,
      text_rich_json TEXT, text_plain TEXT, publication_kind TEXT CHECK(publication_kind IN ('FEED','SHORT','STORY')),
      content_format TEXT CHECK(content_format IN ('TEXT_ONLY','IMAGE','CAROUSEL','VIDEO','VERTICAL_VIDEO','STORY_SEQUENCE')),
      media_plan_json TEXT, options_json TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS publication_units (
      id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES post_targets(id) ON DELETE CASCADE,
      revision_id TEXT NOT NULL REFERENCES content_revisions(id) ON DELETE RESTRICT,
      unit_index INTEGER NOT NULL CHECK(unit_index >= 0), unit_type TEXT NOT NULL CHECK(unit_type IN ('POST','MEDIA_GROUP','STORY')),
      state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PUBLISHING','PUBLISHED','RETRY','FAILED','RECOVERY_NEEDED')),
      attempts INTEGER NOT NULL DEFAULT 0, external_id TEXT, external_url TEXT, last_error TEXT,
      published_at TEXT, updated_at TEXT NOT NULL, UNIQUE(target_id, revision_id, unit_index));`);
}

export function migrate(): void {
  const currentSchemaVersion = Number(db.pragma('user_version', { simple: true }) ?? 0);
  if (currentSchemaVersion > DATABASE_SCHEMA_VERSION) {
    throw new Error(`SQLite schema ${currentSchemaVersion} новее поддерживаемой ${DATABASE_SCHEMA_VERSION}. Запуск старой версии Publikator заблокирован.`);
  }

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
      editorial_stage TEXT NOT NULL DEFAULT 'DRAFT' CHECK(editorial_stage IN ('IDEA','DRAFT','IN_REVIEW','APPROVED','ARCHIVED','TRASHED')),
      schedule_mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK(schedule_mode IN ('MANUAL','AT','QUEUE')),
      scheduled_at TEXT,
      content_version INTEGER NOT NULL DEFAULT 1 CHECK(content_version >= 1),
      ready_revision_id TEXT,
      source_type TEXT,
      source_ref TEXT,
      source_revision TEXT,
      source_payload_hash TEXT,
      source_batch_id TEXT,
      imported_at TEXT,
      imported_content_version INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_revisions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      content_version INTEGER NOT NULL CHECK(content_version >= 1),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      schedule_mode TEXT NOT NULL CHECK(schedule_mode IN ('MANUAL','AT','QUEUE')),
      scheduled_at TEXT,
      targets_json TEXT NOT NULL,
      media_json TEXT NOT NULL,
      actor_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(post_id, content_version)
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
      state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PUBLISHING','PARTIAL','PUBLISHED','RETRY','FAILED','RECOVERY_NEEDED')),
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

    CREATE TABLE IF NOT EXISTS release_acceptance (
      id TEXT PRIMARY KEY,
      target_version TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('telegram','vk','max','instagram')),
      status TEXT NOT NULL CHECK(status IN ('PASS','FAIL')),
      commit_sha TEXT NOT NULL,
      account_name TEXT NOT NULL,
      tested_at TEXT NOT NULL,
      notes TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(target_version, platform)
    );
  `);

  migrateMediaOrder();
  migrateUniqueScheduleSlots();
  if (currentSchemaVersion < 4) migrateContentVersioning();
  if (currentSchemaVersion < 5) migrateIngestionProvenance();
  if (currentSchemaVersion < 6) migrateIngestionSecurity();
  if (currentSchemaVersion < 7) migrateTimeRenditionSequence();
  if (currentSchemaVersion < 8) migrateRichMediaModel(db);
  if (currentSchemaVersion < 9) migrateRevisionHistory(db);
  if (currentSchemaVersion < 10) migrateCanonicalRichText(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_posts_status_schedule ON posts(status, schedule_mode, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_posts_status_schedule_utc ON posts(status, schedule_mode, scheduled_at_utc);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_posts_source_identity ON posts(source_type, source_ref)
      WHERE source_type IS NOT NULL AND source_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_integration_api_keys_active ON integration_api_keys(revoked_at, prefix);
    CREATE INDEX IF NOT EXISTS idx_ingestion_connectors_type ON ingestion_connectors(type, enabled);
    CREATE INDEX IF NOT EXISTS idx_targets_state_retry ON post_targets(state, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id);
    CREATE INDEX IF NOT EXISTS idx_media_poster_asset ON media(poster_asset_id) WHERE poster_asset_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_content_media_post_order ON content_media(post_id, sort_order, created_at);
    CREATE INDEX IF NOT EXISTS idx_content_revisions_post_version ON content_revisions(post_id, content_version);
    CREATE INDEX IF NOT EXISTS idx_publication_units_target_state ON publication_units(target_id, state, unit_index);
    CREATE INDEX IF NOT EXISTS idx_media_post_order ON media(post_id, sort_order, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_created ON publication_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_release_acceptance_version ON release_acceptance(target_version, platform);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_slots_project_weekday_time_timezone
      ON schedule_slots(project_id,weekday,time_hhmm,timezone);
  `);

  const projectCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number };
  if (projectCount.count === 0) {
    db.prepare('INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)')
      .run(id('prj'), 'Основной проект', 'main', nowIso());
  }

  db.prepare("UPDATE post_targets SET state='RECOVERY_NEEDED', last_error=COALESCE(last_error, 'Приложение было остановлено во время публикации. Требуется ручная проверка.'), updated_at=? WHERE state='PUBLISHING'")
    .run(nowIso());
  db.prepare("UPDATE publication_units SET state='RECOVERY_NEEDED',last_error=COALESCE(last_error,'Application stopped during external publication; manual verification required.'),updated_at=? WHERE state='PUBLISHING'").run(nowIso());
  db.prepare("UPDATE post_targets SET state='RECOVERY_NEEDED',updated_at=? WHERE id IN (SELECT DISTINCT target_id FROM publication_units WHERE state='RECOVERY_NEEDED')").run(nowIso());
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
