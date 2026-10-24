import type Database from 'better-sqlite3';

/** Additive schema 14: local administrator ownership, durable sessions and installer-only bootstrap grants. */
export function migrateAdminAuth(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY CHECK(id='owner'),
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL CHECK(length(password_salt)=48),
      password_hash TEXT NOT NULL CHECK(length(password_hash)=128),
      password_version INTEGER NOT NULL DEFAULT 1 CHECK(password_version>=1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
      admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      password_version INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_session_expiry ON admin_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS admin_setup_grants (
      id INTEGER PRIMARY KEY CHECK(id=1),
      mode TEXT NOT NULL CHECK(mode IN ('INITIAL','RECOVER')),
      token_hash TEXT NOT NULL CHECK(length(token_hash)=64),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_legacy_session_revocations (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_legacy_session_revocation_expiry
      ON admin_legacy_session_revocations(expires_at);
  `);
}
