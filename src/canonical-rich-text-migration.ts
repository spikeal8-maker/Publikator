import type Database from 'better-sqlite3';
import { canonicalPlainRichJson, EMPTY_RICH_TEXT_JSON } from './rich-text.js';

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function migrateCanonicalRichText(db: Database.Database): void {
  const postColumns = new Set(
    (db.prepare('PRAGMA table_info(posts)').all() as Array<{ name: string }>).map((row) => row.name)
  );
  if (!postColumns.has('body_rich_json')) {
    db.exec(`ALTER TABLE posts ADD COLUMN body_rich_json TEXT NOT NULL DEFAULT ${sqlLiteral(EMPTY_RICH_TEXT_JSON)}`);
  }

  const revisionColumns = new Set(
    (db.prepare('PRAGMA table_info(content_revisions)').all() as Array<{ name: string }>).map((row) => row.name)
  );
  if (!revisionColumns.has('body_rich_json')) {
    db.exec(`ALTER TABLE content_revisions ADD COLUMN body_rich_json TEXT NOT NULL DEFAULT ${sqlLiteral(EMPTY_RICH_TEXT_JSON)}`);
  }

  const updatePost = db.prepare('UPDATE posts SET body_rich_json=? WHERE id=?');
  const posts = db.prepare('SELECT id,body FROM posts ORDER BY rowid').all() as Array<{ id: string; body: string }>;
  db.transaction(() => {
    for (const post of posts) updatePost.run(canonicalPlainRichJson(post.body), post.id);
  })();

  const updateRevision = db.prepare('UPDATE content_revisions SET body_rich_json=? WHERE id=?');
  const revisions = db.prepare('SELECT id,body FROM content_revisions ORDER BY rowid').all() as Array<{ id: string; body: string }>;
  db.transaction(() => {
    for (const revision of revisions) updateRevision.run(canonicalPlainRichJson(revision.body), revision.id);
  })();

  const empty = sqlLiteral(EMPTY_RICH_TEXT_JSON);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_posts_plain_body_rich_insert
    AFTER INSERT ON posts
    WHEN NEW.body_rich_json = ${empty}
    BEGIN
      UPDATE posts SET body_rich_json=publikator_plain_rich_json(NEW.body) WHERE id=NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_posts_plain_body_rich_update
    AFTER UPDATE OF body ON posts
    WHEN NEW.body <> OLD.body AND NEW.body_rich_json = OLD.body_rich_json
    BEGIN
      UPDATE posts SET body_rich_json=publikator_plain_rich_json(NEW.body) WHERE id=NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_content_revisions_plain_body_rich_insert
    AFTER INSERT ON content_revisions
    WHEN NEW.body_rich_json = ${empty}
    BEGIN
      UPDATE content_revisions SET body_rich_json=publikator_plain_rich_json(NEW.body) WHERE id=NEW.id;
    END;
  `);
}
