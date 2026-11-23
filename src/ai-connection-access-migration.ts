import type Database from 'better-sqlite3';

export function migrateAiConnectionAccess(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(owner_ai_connections)').all() as Array<{ name: string }>;
  if (columns.some(({ name }) => name === 'access_mode')) return;
  db.exec(`ALTER TABLE owner_ai_connections ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'OWNER_TOOLS'
    CHECK(access_mode IN ('READ_ONLY', 'OWNER_TOOLS'))`);
}
