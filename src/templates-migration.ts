import type Database from 'better-sqlite3';

export function migrateTemplates(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      template_type TEXT NOT NULL DEFAULT 'POST'
        CHECK(template_type IN ('POST','STORY','SHORT','CAMPAIGN','SNIPPET','CTA','SIGNATURE','HASHTAG_SET')),
      body_rich_json TEXT NOT NULL,
      body_plain TEXT NOT NULL,
      publication_kind TEXT NOT NULL
        CHECK(publication_kind IN ('FEED','SHORT','STORY')),
      content_format TEXT NOT NULL
        CHECK(content_format IN ('TEXT_ONLY','IMAGE','CAROUSEL','VIDEO','VERTICAL_VIDEO','STORY_SEQUENCE')),
      schedule_mode TEXT NOT NULL
        CHECK(schedule_mode IN ('MANUAL','AT','QUEUE')),
      target_account_ids_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_templates_project_updated
      ON templates(project_id, updated_at DESC);
  `);
}
