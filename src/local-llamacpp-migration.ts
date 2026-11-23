import type Database from 'better-sqlite3';

export function migrateLocalLlamaCppProvider(db: Database.Database): void {
  // SQLite requires rebuilding a table to widen a CHECK constraint.
  db.transaction(() => db.exec(`
    CREATE TABLE owner_ai_connections_v22 (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('openai','deepseek','compatible','ollama','llamacpp')),
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      credentials_encrypted TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
      tool_verified INTEGER NOT NULL DEFAULT 0 CHECK(tool_verified IN (0,1)),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      access_mode TEXT NOT NULL DEFAULT 'OWNER_TOOLS' CHECK(access_mode IN ('READ_ONLY','OWNER_TOOLS'))
    );
    INSERT INTO owner_ai_connections_v22 (
      id,owner_id,name,provider,base_url,model,credentials_encrypted,revision,tool_verified,enabled,created_at,updated_at,access_mode
    ) SELECT id,owner_id,name,provider,base_url,model,credentials_encrypted,revision,tool_verified,enabled,created_at,updated_at,access_mode
      FROM owner_ai_connections;
    DROP TABLE owner_ai_connections;
    ALTER TABLE owner_ai_connections_v22 RENAME TO owner_ai_connections;
  `)).immediate();
}
