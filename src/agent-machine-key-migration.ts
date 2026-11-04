import type Database from 'better-sqlite3';

/**
 * Schema 17: high-entropy machine-token digests for server-side bots only.
 * Keys grant nothing without a current AgentGrant and independently-verified
 * client-kind/resource policy. Never persist, log or back up raw token text.
 */
export function migrateAgentMachineKeys(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_machine_keys (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 4 AND 128),
        agent_id TEXT NOT NULL REFERENCES agent_principals(id) ON DELETE RESTRICT,
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
        prefix TEXT NOT NULL CHECK(length(prefix) BETWEEN 8 AND 24),
        scope_ids_json TEXT NOT NULL
          CHECK(json_valid(scope_ids_json) AND json_type(scope_ids_json)='array'),
        token_version INTEGER NOT NULL CHECK(token_version >= 1),
        grant_version INTEGER NOT NULL CHECK(grant_version >= 1),
        expires_at TEXT NOT NULL CHECK(length(expires_at) BETWEEN 20 AND 40),
        revoked_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_machine_keys_agent
        ON agent_machine_keys(agent_id,created_at DESC,id);
      CREATE INDEX IF NOT EXISTS idx_agent_machine_keys_status
        ON agent_machine_keys(agent_id,revoked_at,expires_at);
    `);
  }).immediate();
}
