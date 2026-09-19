import type Database from 'better-sqlite3';

export function migrateProjectDefaults(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((row) => row.name)
  );
  if (!columns.has('default_timezone')) {
    db.exec("ALTER TABLE projects ADD COLUMN default_timezone TEXT NOT NULL DEFAULT 'UTC'");
  }
}
