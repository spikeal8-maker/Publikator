import type Database from 'better-sqlite3';

/**
 * Schema 16, AGENT-A1b1. Original owner-operation results are immutable
 * and persist across grant changes, process restarts and backup/restore.
 * No bearer, OAuth, social credential, request body or provider response is
 * stored here. Only the server-constructed public Agent/AgentGrant DTO.
 */
export function migrateAgentOwnerReceipts(db: Database.Database): void {
  db.transaction(() => {
    db.exec([
      'CREATE TABLE IF NOT EXISTS agent_owner_operation_receipts (',
      'request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 8 AND 128),',
      'agent_id TEXT NOT NULL REFERENCES agent_principals(id) ON DELETE RESTRICT,',
      'operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),',
      'request_hash TEXT NOT NULL CHECK(length(request_hash)=64),',
      'response_json TEXT NOT NULL',
      "CHECK(json_valid(response_json) AND json_type(response_json)='object'",
      'AND length(response_json) BETWEEN 2 AND 65536),',
      'created_at TEXT NOT NULL',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_agent_owner_receipts_by_agent',
      'ON agent_owner_operation_receipts(agent_id,created_at DESC);'
    ].join(' '));
  }).immediate();
}
