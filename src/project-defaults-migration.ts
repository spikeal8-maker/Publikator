import type Database from 'better-sqlite3';

export function migrateProjectDefaults(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((row) => row.name)
  );
  if (!columns.has('default_timezone')) {
    db.exec("ALTER TABLE projects ADD COLUMN default_timezone TEXT NOT NULL DEFAULT 'UTC'");
  }

  const hadDefaultTargets = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_default_targets'").get()
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_default_targets (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, account_id)
    )
  `);

  if (!hadDefaultTargets) {
    db.exec(`
      INSERT INTO project_default_targets (project_id,account_id,created_at)
      SELECT p.id,a.id,CASE WHEN p.created_at >= a.created_at THEN p.created_at ELSE a.created_at END
      FROM projects p CROSS JOIN social_accounts a
      WHERE a.enabled=1
    `);
  }
}
