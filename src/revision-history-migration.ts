import type Database from 'better-sqlite3';

export function migrateRevisionHistory(db: Database.Database): void {
  const revisionColumns = new Set(
    (db.prepare('PRAGMA table_info(content_revisions)').all() as Array<{ name: string }>).map((row) => row.name)
  );

  if (!revisionColumns.has('editorial_stage')) {
    db.exec("ALTER TABLE content_revisions ADD COLUMN editorial_stage TEXT NOT NULL DEFAULT 'DRAFT' CHECK(editorial_stage IN ('IDEA','DRAFT','IN_REVIEW','APPROVED','ARCHIVED','TRASHED'))");
  }
  if (!revisionColumns.has('restored_from_revision_id')) {
    db.exec('ALTER TABLE content_revisions ADD COLUMN restored_from_revision_id TEXT REFERENCES content_revisions(id) ON DELETE SET NULL');
  }

  db.exec("UPDATE content_revisions SET editorial_stage='APPROVED' WHERE id IN (SELECT ready_revision_id FROM posts WHERE ready_revision_id IS NOT NULL)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_content_revisions_restored_from ON content_revisions(restored_from_revision_id) WHERE restored_from_revision_id IS NOT NULL");
}
