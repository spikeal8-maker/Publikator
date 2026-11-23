import type Database from 'better-sqlite3';

export function migrateAgentOAuthStorage(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_oauth_artifacts (
        model TEXT NOT NULL,
        id_digest TEXT NOT NULL CHECK(length(id_digest) = 64),
        payload_encrypted TEXT NOT NULL,
        expires_at INTEGER,
        consumed_at INTEGER,
        uid_digest TEXT,
        user_code_digest TEXT,
        grant_digest TEXT,
        PRIMARY KEY (model, id_digest)
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_oauth_uid
        ON agent_oauth_artifacts(model, uid_digest) WHERE uid_digest IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_oauth_user_code
        ON agent_oauth_artifacts(model, user_code_digest) WHERE user_code_digest IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_agent_oauth_grant
        ON agent_oauth_artifacts(grant_digest) WHERE grant_digest IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_agent_oauth_expiry
        ON agent_oauth_artifacts(expires_at) WHERE expires_at IS NOT NULL;
    `);
  }).immediate();
}
