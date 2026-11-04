import type Database from 'better-sqlite3';

/** Schema 19: additive owner delegation, model connections and durable chat/tool receipts. */
export function migrateOwnerAutomation(db: Database.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS owner_automation_keys (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE CHECK(length(key_hash)=64),
      role TEXT NOT NULL CHECK(role='OWNER_ADMIN'),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS owner_ai_connections (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('openai','deepseek','compatible','ollama')),
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      credentials_encrypted TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
      tool_verified INTEGER NOT NULL DEFAULT 0 CHECK(tool_verified IN (0,1)),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_ai_uploads (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
      sha256 TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'READY' CHECK(state IN ('READY','UPLOADING','WRITING','BROKEN','ABORTED')),
      uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK(uploaded_bytes>=0), expected_sha256 TEXT
    );
    CREATE TABLE IF NOT EXISTS owner_ai_threads (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_ai_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES owner_ai_threads(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      message_encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(thread_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS owner_ai_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES owner_ai_threads(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL,
      request_key_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
      current_operation TEXT,
      result_encrypted TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_id,request_key_hash)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS owner_ai_one_running_thread ON owner_ai_runs(thread_id) WHERE status='RUNNING';
    CREATE TABLE IF NOT EXISTS owner_automation_receipts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_key_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('STARTED','COMPLETED','RECOVERY_NEEDED')),
      result_encrypted TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(actor_id,operation,request_key_hash)
    );
    CREATE TABLE IF NOT EXISTS owner_automation_events (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      receipt_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS owner_automation_events_time ON owner_automation_events(owner_id,created_at,id);
    CREATE INDEX IF NOT EXISTS owner_ai_threads_time ON owner_ai_threads(owner_id,updated_at,id);
  `)).immediate();
}
