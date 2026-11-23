import type Database from 'better-sqlite3';

export function migrateAgentPublicationIntents(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_publication_intents (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_principals(id) ON DELETE RESTRICT,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE RESTRICT,
      revision_id TEXT NOT NULL REFERENCES content_revisions(id) ON DELETE RESTRICT,
      content_version INTEGER NOT NULL CHECK(content_version >= 1),
      grant_version INTEGER NOT NULL CHECK(grant_version >= 1),
      token_version INTEGER NOT NULL CHECK(token_version >= 1),
      idempotency_hash TEXT NOT NULL CHECK(length(idempotency_hash) = 64),
      request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
      content_digest TEXT NOT NULL CHECK(length(content_digest) = 64),
      destinations_digest TEXT NOT NULL CHECK(length(destinations_digest) = 64),
      target_ids_json TEXT NOT NULL CHECK(json_valid(target_ids_json) AND json_type(target_ids_json)='array'),
      mode TEXT NOT NULL CHECK(mode IN ('NOW','AT')),
      scheduled_at_utc TEXT,
      schedule_timezone TEXT,
      preflight_json TEXT NOT NULL CHECK(json_valid(preflight_json) AND json_type(preflight_json)='object'),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL CHECK(expires_at > created_at),
      UNIQUE(agent_id, idempotency_hash),
      CHECK((mode='NOW' AND scheduled_at_utc IS NULL AND schedule_timezone IS NULL)
        OR (mode='AT' AND scheduled_at_utc IS NOT NULL AND schedule_timezone IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_publication_intents_post
      ON agent_publication_intents(post_id, created_at DESC);
    CREATE TRIGGER IF NOT EXISTS trg_agent_publication_intent_matches_draft
      BEFORE INSERT ON agent_publication_intents
      WHEN NOT EXISTS (
        SELECT 1 FROM agent_draft_ownership o JOIN posts p ON p.id=o.post_id
        JOIN content_revisions r ON r.post_id=p.id
        JOIN agent_principals a ON a.id=o.agent_id
        JOIN agent_grants g ON g.agent_id=a.id
        WHERE p.id=NEW.post_id AND o.agent_id=NEW.agent_id AND r.id=NEW.revision_id
          AND p.content_version=NEW.content_version AND r.content_version=NEW.content_version
          AND p.status='DRAFT' AND p.schedule_mode='MANUAL'
          AND a.status='ACTIVE' AND a.token_version=NEW.token_version
          AND g.grant_version=NEW.grant_version AND g.publish_mode='OWNER_APPROVAL'
      )
      BEGIN SELECT RAISE(ABORT, 'AGENT_PUBLICATION_INTENT_INVALID'); END;
    CREATE TRIGGER IF NOT EXISTS trg_agent_publication_intent_immutable
      BEFORE UPDATE ON agent_publication_intents
      BEGIN SELECT RAISE(ABORT, 'AGENT_PUBLICATION_INTENT_IMMUTABLE'); END;
  `);
}
