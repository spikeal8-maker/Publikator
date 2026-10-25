import type Database from 'better-sqlite3';

/**
 * Schema 15 (AGENT-A1a): durable owner-scoped agent identities, permission
 * snapshots and sanitized, append-only-by-application activity records.
 *
 * This is storage only. No agent HTTP/MCP route, OAuth issuer, token minting,
 * publish permission, or external action is enabled by this migration.
 */
export function migrateAgentOwnership(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_principals (
        id TEXT PRIMARY KEY,
        owner_admin_id TEXT NOT NULL DEFAULT 'owner'
          REFERENCES admin_users(id) ON DELETE RESTRICT
          CHECK(owner_admin_id = 'owner'),
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
        client_kind TEXT NOT NULL CHECK(client_kind IN (
          'chatgpt','codex','claude','cursor','n8n',
          'telegram_bot','max_bot','custom_mcp','rest_client'
        )),
        status TEXT NOT NULL DEFAULT 'ACTIVE'
          CHECK(status IN ('ACTIVE','PAUSED','REVOKED')),
        token_version INTEGER NOT NULL DEFAULT 1 CHECK(token_version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_principal_owner_status
        ON agent_principals(owner_admin_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS agent_grants (
        agent_id TEXT PRIMARY KEY
          REFERENCES agent_principals(id) ON DELETE RESTRICT,
        preset_id TEXT NOT NULL DEFAULT 'OBSERVER' CHECK(preset_id IN (
          'OBSERVER','LIMITED','EXTENDED','FULL_CONTENT','CUSTOM'
        )),
        preset_version INTEGER NOT NULL DEFAULT 1 CHECK(preset_version >= 1),
        grant_version INTEGER NOT NULL DEFAULT 1 CHECK(grant_version >= 1),
        scope_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(scope_ids_json) AND json_type(scope_ids_json)='array'),
        project_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(project_ids_json) AND json_type(project_ids_json)='array'),
        account_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(account_ids_json) AND json_type(account_ids_json)='array'),
        source_connector_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(source_connector_ids_json)
            AND json_type(source_connector_ids_json)='array'),
        publish_mode TEXT NOT NULL DEFAULT 'DRAFT_ONLY'
          CHECK(publish_mode IN ('DRAFT_ONLY','OWNER_APPROVAL','PREAPPROVED_POLICY')),
        preapproved_policy_json TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (publish_mode='PREAPPROVED_POLICY'
            AND preapproved_policy_json IS NOT NULL
            AND json_valid(preapproved_policy_json)
            AND json_type(preapproved_policy_json)='object'
            AND CAST(json_extract(preapproved_policy_json,'$.approvedPolicyVersion') AS INTEGER)>=1)
          OR
          (publish_mode!='PREAPPROVED_POLICY' AND preapproved_policy_json IS NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_agent_grants_mode_expiry
        ON agent_grants(publish_mode, expires_at);

      CREATE TABLE IF NOT EXISTS agent_activity_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 4 AND 128),
        agent_id TEXT REFERENCES agent_principals(id) ON DELETE RESTRICT,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('AGENT','OWNER','SYSTEM')),
        origin TEXT NOT NULL CHECK(origin IN ('MCP','REST','UI','SCHEDULER','RECOVERY','SYSTEM')),
        client_kind TEXT,
        request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
        correlation_id TEXT,
        operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
        job_id TEXT,
        post_id TEXT,
        project_id TEXT,
        target_account_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(target_account_ids_json)
            AND json_type(target_account_ids_json)='array'),
        publication_intent_id TEXT,
        grant_version INTEGER CHECK(grant_version>=1),
        stage TEXT NOT NULL CHECK(stage IN (
          'REQUESTED','AUTHORIZED','STARTED','PROGRESS','WAITING_APPROVAL',
          'SCHEDULED','COMPLETED','FAILED','DENIED','RECOVERY_NEEDED',
          'POLICY_CHANGED','PAUSED','REVOKED','PARTIAL'
        )),
        outcome TEXT CHECK(outcome IN (
          'PENDING','SUCCEEDED','PARTIAL','FAILED','DENIED','UNKNOWN'
        )),
        safe_summary TEXT NOT NULL CHECK(length(safe_summary) BETWEEN 1 AND 240),
        error_code TEXT CHECK(length(error_code) BETWEEN 1 AND 80),
        remediation_code TEXT CHECK(length(remediation_code) BETWEEN 1 AND 80),
        progress_completed INTEGER,
        progress_total INTEGER,
        duration_ms INTEGER CHECK(duration_ms>=0),
        occurred_at TEXT NOT NULL,
        CHECK(actor_type!='AGENT' OR agent_id IS NOT NULL),
        CHECK (
          (progress_completed IS NULL AND progress_total IS NULL)
          OR
          (progress_completed >= 0 AND progress_total >= 1
            AND progress_completed <= progress_total)
        ),
        CHECK(stage!='PROGRESS' OR
          (job_id IS NOT NULL AND progress_completed IS NOT NULL
            AND progress_total IS NOT NULL))
      );

      CREATE INDEX IF NOT EXISTS idx_agent_activity_by_agent
        ON agent_activity_events(agent_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_activity_by_job
        ON agent_activity_events(job_id, sequence DESC)
        WHERE job_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_agent_activity_by_post
        ON agent_activity_events(post_id, sequence DESC)
        WHERE post_id IS NOT NULL;
    `);
  }).immediate();
}
