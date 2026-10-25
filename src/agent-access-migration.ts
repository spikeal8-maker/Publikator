import type Database from 'better-sqlite3';

/**
 * A1a: additive schema for agent identities and owner-scoped permission snapshots.
 * No default agents, bearer keys, HTTP routes, OAuth sessions or publishing side effects.
 */
export function migrateAgentPrincipalsAndGrants(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_principals (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 4 AND 128),
      owner_admin_id TEXT NOT NULL DEFAULT 'owner'
        REFERENCES admin_users(id) ON DELETE RESTRICT
        CHECK(owner_admin_id = 'owner'),
      display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 160),
      client_kind TEXT NOT NULL
        CHECK(client_kind IN ('chatgpt','codex','claude','cursor','n8n','telegram_bot','max_bot','custom_mcp','rest_client')),
      status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK(status IN ('ACTIVE','PAUSED','REVOKED')),
      token_version INTEGER NOT NULL DEFAULT 1 CHECK(token_version >= 1),
      last_used_at TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_grants (
      agent_id TEXT PRIMARY KEY
        REFERENCES agent_principals(id) ON DELETE CASCADE,
      preset_id TEXT NOT NULL DEFAULT 'OBSERVER'
        CHECK(preset_id IN ('OBSERVER','LIMITED','EXTENDED','FULL_CONTENT','CUSTOM')),
      preset_version INTEGER NOT NULL DEFAULT 1 CHECK(preset_version >= 1),
      publish_mode TEXT NOT NULL DEFAULT 'DRAFT_ONLY'
        CHECK(publish_mode IN ('DRAFT_ONLY','OWNER_APPROVAL','PREAPPROVED_POLICY')),
      grant_version INTEGER NOT NULL DEFAULT 1 CHECK(grant_version >= 1),

      -- Exact owner-approved snapshots; empty arrays are the safe default.
      scope_ids_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(scope_ids_json) AND json_type(scope_ids_json) = 'array'),
      project_ids_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(project_ids_json) AND json_type(project_ids_json) = 'array'),
      account_ids_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(account_ids_json) AND json_type(account_ids_json) = 'array'),
      source_connector_ids_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(source_connector_ids_json) AND json_type(source_connector_ids_json) = 'array'),

      -- Automation is separately approved; FULL_CONTENT alone is insufficient.
      preapproved_policy_json TEXT
        CHECK(preapproved_policy_json IS NULL OR
          (json_valid(preapproved_policy_json) AND json_type(preapproved_policy_json) = 'object')),
      policy_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(publish_mode != 'PREAPPROVED_POLICY' OR preapproved_policy_json IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_principals_owner_status
      ON agent_principals(owner_admin_id, status);
    CREATE INDEX IF NOT EXISTS idx_agent_principals_last_used
      ON agent_principals(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_agent_grants_mode_preset
      ON agent_grants(publish_mode, preset_id);
  `);
}
