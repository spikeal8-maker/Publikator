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
            AND COALESCE(json_type(preapproved_policy_json,'$.approvedPolicyVersion')='integer',0)
            AND COALESCE(CAST(json_extract(preapproved_policy_json,'$.approvedPolicyVersion') AS INTEGER)>=1,0))
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
            AND json_type(target_account_ids_json)='array'
            AND length(CAST(target_account_ids_json AS BLOB)) BETWEEN 2 AND 4096),
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
        safe_summary TEXT NOT NULL CHECK(
          length(safe_summary) BETWEEN 1 AND 240
          AND length(CAST(safe_summary AS BLOB)) BETWEEN 1 AND 960
          AND instr(safe_summary, char(0))=0
        ),
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
    ensureAgentAuditGuards(db);
  }).immediate();
}

/**
 * SQLite's typeof(TEXT), length() and JSON1 do not validate UTF-8:
 * CAST(X'FF' AS TEXT) can otherwise evade audit CHECK constraints.
 *
 * Reconstruct a bounded TEXT value, one decoded codepoint at a time, using
 * SQLite's own unicode()/char() functions. Exact BLOB comparison rejects
 * malformed, overlong, truncated, surrogate and out-of-range sequences while
 * preserving a real U+FFFD. The callers reject large values *before* this
 * recursive CTE runs. No SQLite extension or application UDF is required.
 */
function utf8RoundtripMatches(value: string): string {
  return `(
    WITH RECURSIVE utf8_reconstruction(pos, reencoded) AS (
      SELECT 1, CAST('' AS TEXT)
      UNION ALL
      SELECT pos + 1, reencoded || char(unicode(substr(${value}, pos, 1)))
      FROM utf8_reconstruction
      WHERE pos <= length(${value})
    )
    SELECT CAST(reencoded AS BLOB) = CAST(${value} AS BLOB)
    FROM utf8_reconstruction WHERE pos = length(${value}) + 1
  )`;
}

/**
 * Replace only the two A1a-owned audit guards. Trigger DDL is transactional:
 * a failed replacement rolls back both drops and recreations, preserving the
 * previous guards and every historical row. It is safe on 14->15, existing
 * v15 (including old trigger definitions), and repeated startup/restore.
 */
export function ensureAgentAuditGuards(db: Database.Database): void {
  const summaryValidUtf8 = utf8RoundtripMatches('NEW.safe_summary');
  const targetIdsValidUtf8 = utf8RoundtripMatches('NEW.target_account_ids_json');
  const validate = `
    SELECT RAISE(ABORT, 'AGENT_AUDIT_INVALID_SUMMARY')
    WHERE CASE
      WHEN typeof(NEW.safe_summary) <> 'text' THEN 1
      WHEN length(CAST(NEW.safe_summary AS BLOB)) NOT BETWEEN 1 AND 960 THEN 1
      WHEN length(NEW.safe_summary) NOT BETWEEN 1 AND 240 THEN 1
      WHEN instr(CAST(NEW.safe_summary AS BLOB), X'00') <> 0 THEN 1
      WHEN COALESCE(${summaryValidUtf8}, 0) <> 1 THEN 1
      ELSE 0
    END;

    SELECT RAISE(ABORT, 'AGENT_AUDIT_INVALID_TARGET_IDS')
    WHERE CASE
      WHEN typeof(NEW.target_account_ids_json) <> 'text' THEN 1
      WHEN length(CAST(NEW.target_account_ids_json AS BLOB)) NOT BETWEEN 2 AND 4096 THEN 1
      WHEN COALESCE(${targetIdsValidUtf8}, 0) <> 1 THEN 1
      WHEN COALESCE(json_valid(NEW.target_account_ids_json), 0) <> 1 THEN 1
      WHEN json_type(NEW.target_account_ids_json) <> 'array' THEN 1
      WHEN (SELECT COUNT(*) FROM json_each(NEW.target_account_ids_json)) > 20 THEN 1
      WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.target_account_ids_json) AS item
        WHERE item.type <> 'text'
          OR length(item.value) NOT BETWEEN 1 AND 128
          OR instr(CAST(item.value AS BLOB), X'00') <> 0
          OR item.value GLOB '*[^A-Za-z0-9._:-]*'
      ) THEN 1
      ELSE 0
    END;
  `;

  // better-sqlite3 uses SAVEPOINT for nested transactions, so the same code
  // is atomic when called from migrateAgentOwnership() or migrate() and when
  // invoked independently against an already-initialized v15 database.
  db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_agent_audit_payload_insert;
      DROP TRIGGER IF EXISTS trg_agent_audit_payload_update;
      CREATE TRIGGER trg_agent_audit_payload_insert
      BEFORE INSERT ON agent_activity_events
      BEGIN
        ${validate}
      END;
      CREATE TRIGGER trg_agent_audit_payload_update
      BEFORE UPDATE ON agent_activity_events
      BEGIN
        ${validate}
      END;
    `);
  }).immediate();
}
