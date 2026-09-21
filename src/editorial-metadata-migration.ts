import type Database from 'better-sqlite3';

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

export function migrateEditorialMetadata(db: Database.Database): void {
  const postColumns = columns(db, 'posts');
  if (!postColumns.has('editor_note')) db.exec('ALTER TABLE posts ADD COLUMN editor_note TEXT');
  if (!postColumns.has('source_note')) db.exec('ALTER TABLE posts ADD COLUMN source_note TEXT');
  if (!postColumns.has('tags_json')) db.exec("ALTER TABLE posts ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
  if (!postColumns.has('campaign')) db.exec('ALTER TABLE posts ADD COLUMN campaign TEXT');

  const revisionColumns = columns(db, 'content_revisions');
  if (!revisionColumns.has('editor_note')) db.exec('ALTER TABLE content_revisions ADD COLUMN editor_note TEXT');
  if (!revisionColumns.has('source_note')) db.exec('ALTER TABLE content_revisions ADD COLUMN source_note TEXT');
  if (!revisionColumns.has('tags_json')) db.exec("ALTER TABLE content_revisions ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
  if (!revisionColumns.has('campaign')) db.exec('ALTER TABLE content_revisions ADD COLUMN campaign TEXT');

  db.exec('CREATE INDEX IF NOT EXISTS idx_posts_campaign ON posts(campaign) WHERE campaign IS NOT NULL');
}
