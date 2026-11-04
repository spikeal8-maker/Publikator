import type Database from 'better-sqlite3';

/**
 * AGENT-A2b0 / SQLite schema 18: storage only.
 * Agent-origin posts remain DRAFT + MANUAL until separately accepted consent
 * and execution guards. No REST/MCP route or social POST is enabled here.
 */
export function migrateAgentDraftProvenance(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_draft_ownership (
        post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE RESTRICT,
        agent_id TEXT NOT NULL REFERENCES agent_principals(id) ON DELETE RESTRICT,
        creation_grant_version INTEGER NOT NULL CHECK(creation_grant_version >= 1),
        creation_operation_id TEXT NOT NULL
          CHECK(length(creation_operation_id) BETWEEN 1 AND 128),
        origin_kind TEXT NOT NULL DEFAULT 'AGENT_CREATED'
          CHECK(origin_kind='AGENT_CREATED'),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_draft_ownership_agent
        ON agent_draft_ownership(agent_id,created_at DESC,post_id);

      CREATE TABLE IF NOT EXISTS agent_operation_receipts (
        receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) BETWEEN 4 AND 128),
        agent_id TEXT NOT NULL REFERENCES agent_principals(id) ON DELETE RESTRICT,
        operation_name TEXT NOT NULL
          CHECK(length(operation_name) BETWEEN 1 AND 128),
        idempotency_key_hash TEXT NOT NULL CHECK(
          length(idempotency_key_hash)=64
          AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
        canonical_payload_hash TEXT NOT NULL CHECK(
          length(canonical_payload_hash)=64
          AND canonical_payload_hash NOT GLOB '*[^0-9a-f]*'
        ),
        post_id TEXT REFERENCES posts(id) ON DELETE RESTRICT,
        phase TEXT NOT NULL CHECK(
          phase IN ('CLAIMED','COMPLETED','FAILED','RECOVERY_NEEDED')
        ),
        result_json TEXT CHECK(
          result_json IS NULL OR (
            json_valid(result_json)
            AND json_type(result_json)='object'
            AND length(result_json) BETWEEN 2 AND 4096
            AND json_remove(result_json,'$.postId','$.contentVersion','$.status')='{}'
            AND (
              json_type(result_json,'$.postId') IS NULL
              OR json_type(result_json,'$.postId')='text'
            )
            AND (
              json_type(result_json,'$.contentVersion') IS NULL
              OR (
                json_type(result_json,'$.contentVersion')='integer'
                AND json_extract(result_json,'$.contentVersion') >= 1
              )
            )
            AND (
              json_type(result_json,'$.status') IS NULL
              OR json_extract(result_json,'$.status')='DRAFT'
            )
            AND (
              json_type(result_json,'$.postId') IS NULL
              OR (
                post_id IS NOT NULL
                AND COALESCE(json_extract(result_json,'$.postId'),'')=post_id
              )
            )
          )
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id,operation_name,idempotency_key_hash),
        CHECK(
          phase!='COMPLETED' OR (
            post_id IS NOT NULL
            AND result_json IS NOT NULL
            AND COALESCE(json_extract(result_json,'$.postId'),'')=post_id
            AND COALESCE(json_extract(result_json,'$.status'),'')='DRAFT'
          )
        )
      );
      CREATE INDEX IF NOT EXISTS idx_agent_operation_receipts_agent
        ON agent_operation_receipts(agent_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_operation_receipts_post
        ON agent_operation_receipts(post_id,created_at DESC)
        WHERE post_id IS NOT NULL;

      CREATE TRIGGER IF NOT EXISTS trg_agent_draft_ownership_initial_safety
      BEFORE INSERT ON agent_draft_ownership
      WHEN NOT EXISTS (
        SELECT 1 FROM posts p WHERE p.id=NEW.post_id
          AND p.source_type='agent-api'
          AND p.status='DRAFT'
          AND p.schedule_mode='MANUAL'
          AND p.scheduled_at IS NULL
          AND p.scheduled_at_utc IS NULL
          AND p.editorial_stage IN ('IDEA','DRAFT','IN_REVIEW')
      ) OR NOT EXISTS (
        SELECT 1 FROM agent_principals p
        JOIN agent_grants g ON g.agent_id=p.id
        WHERE p.id=NEW.agent_id AND p.status='ACTIVE'
          AND g.grant_version=NEW.creation_grant_version
      )
      BEGIN
        SELECT RAISE(ABORT, 'AGENT_DRAFT_ONLY');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_agent_receipt_exact_owner
      BEFORE INSERT ON agent_operation_receipts
      WHEN NEW.post_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM agent_draft_ownership o
        WHERE o.post_id=NEW.post_id AND o.agent_id=NEW.agent_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'AGENT_RECEIPT_FOREIGN_POST');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_agent_receipt_owner_on_update
      BEFORE UPDATE ON agent_operation_receipts
      WHEN NEW.post_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM agent_draft_ownership o
        WHERE o.post_id=NEW.post_id AND o.agent_id=NEW.agent_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'AGENT_RECEIPT_FOREIGN_POST');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_agent_receipt_immutable_identity
      BEFORE UPDATE ON agent_operation_receipts
      WHEN NEW.receipt_id IS NOT OLD.receipt_id
        OR NEW.agent_id IS NOT OLD.agent_id
        OR NEW.operation_name IS NOT OLD.operation_name
        OR NEW.idempotency_key_hash IS NOT OLD.idempotency_key_hash
        OR NEW.canonical_payload_hash IS NOT OLD.canonical_payload_hash
        OR NEW.created_at IS NOT OLD.created_at
        OR (OLD.post_id IS NOT NULL AND NEW.post_id IS NOT OLD.post_id)
        OR (OLD.phase IN ('COMPLETED','FAILED') AND (
          NEW.phase IS NOT OLD.phase
          OR NEW.result_json IS NOT OLD.result_json
          OR NEW.post_id IS NOT OLD.post_id
        ))
      BEGIN
        SELECT RAISE(ABORT, 'AGENT_RECEIPT_IMMUTABLE');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_agent_receipt_no_delete
      BEFORE DELETE ON agent_operation_receipts
      BEGIN
        SELECT RAISE(ABORT, 'AGENT_RECEIPT_IMMUTABLE');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_agent_draft_ownership_immutable
      BEFORE UPDATE ON agent_draft_ownership
      BEGIN
        SELECT RAISE(ABORT, 'AGENT_OWNER_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_agent_draft_ownership_no_delete
      BEFORE DELETE ON agent_draft_ownership
      BEGIN
        SELECT RAISE(ABORT, 'AGENT_OWNER_IMMUTABLE');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_agent_draft_initial_no_publish
      BEFORE INSERT ON posts
      WHEN NEW.source_type='agent-api' AND (
        NEW.status!='DRAFT'
        OR NEW.schedule_mode!='MANUAL'
        OR NEW.scheduled_at IS NOT NULL
        OR NEW.scheduled_at_utc IS NOT NULL
        OR NEW.editorial_stage NOT IN ('IDEA','DRAFT','IN_REVIEW')
      )
      BEGIN
        SELECT RAISE(ABORT, 'AGENT_OWNER_CONSENT_REQUIRED');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_agent_draft_no_external_publish
      BEFORE UPDATE OF status,editorial_stage,schedule_mode,scheduled_at,
        scheduled_at_utc,source_type ON posts
      WHEN (
        OLD.source_type='agent-api'
        OR NEW.source_type='agent-api'
        OR EXISTS (SELECT 1 FROM agent_draft_ownership o WHERE o.post_id=OLD.id)
      ) AND (
        NEW.status!='DRAFT'
        OR NEW.schedule_mode!='MANUAL'
        OR NEW.scheduled_at IS NOT NULL
        OR NEW.scheduled_at_utc IS NOT NULL
        OR NEW.source_type!='agent-api'
        OR NEW.editorial_stage NOT IN ('IDEA','DRAFT','IN_REVIEW','ARCHIVED','TRASHED')
      )
      BEGIN
        SELECT RAISE(ABORT, 'AGENT_OWNER_CONSENT_REQUIRED');
      END;
    `);
  }).immediate();
}
