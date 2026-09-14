type SqliteDb = {
  prepare: (sql: string) => any;
  exec: (sql: string) => void;
  transaction: (fn: () => void) => () => void;
};

type RevisionRow = { id: string; content_format: string; media_json: string };
type MediaSnapshot = { id?: string; sort_order?: number; [key: string]: unknown };

function roleForFormat(format: string): string {
  if (format === 'CAROUSEL') return 'carousel_item';
  if (format === 'STORY_SEQUENCE') return 'story_item';
  if (format === 'VIDEO' || format === 'VERTICAL_VIDEO') return 'video';
  return 'primary';
}

export function migrateRichMediaModel(db: SqliteDb): void {
  const mediaColumns = new Set((db.prepare('PRAGMA table_info(media)').all() as Array<{ name: string }>).map((row) => row.name));
  for (const [name, type] of [
    ['duration_ms', 'INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0)'],
    ['fps', 'REAL CHECK(fps IS NULL OR fps > 0)'],
    ['video_codec', 'TEXT'],
    ['audio_codec', 'TEXT'],
    ['container', 'TEXT'],
    ['poster_asset_id', 'TEXT']
  ] as const) {
    if (!mediaColumns.has(name)) db.exec(`ALTER TABLE media ADD COLUMN ${name} ${type}`);
  }

  const revisionColumns = new Set((db.prepare('PRAGMA table_info(content_revisions)').all() as Array<{ name: string }>).map((row) => row.name));
  if (!revisionColumns.has('content_media_json')) {
    db.exec("ALTER TABLE content_revisions ADD COLUMN content_media_json TEXT NOT NULL DEFAULT '[]'");
  }

  db.exec(`CREATE TABLE IF NOT EXISTS content_media (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
    role TEXT NOT NULL CHECK(role IN ('primary','carousel_item','story_item','video','poster')),
    preview_duration_ms INTEGER CHECK(preview_duration_ms IS NULL OR preview_duration_ms > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(post_id,media_id)
  );`);

  const rows = db.prepare(`SELECT m.id,m.post_id,m.sort_order,m.created_at,p.content_format
    FROM media m JOIN posts p ON p.id=m.post_id ORDER BY m.post_id,m.sort_order,m.created_at`).all() as Array<{
      id: string; post_id: string; sort_order: number; created_at: string; content_format: string;
    }>;
  const insertContentMedia = db.prepare(`INSERT OR IGNORE INTO content_media
    (id,post_id,media_id,sort_order,role,preview_duration_ms,created_at,updated_at)
    VALUES (?,?,?,?,?,NULL,?,?)`);
  db.transaction(() => {
    for (const row of rows) {
      insertContentMedia.run(`cm_${row.id}`, row.post_id, row.id, row.sort_order, roleForFormat(row.content_format), row.created_at, row.created_at);
    }
  })();

  const revisions = db.prepare('SELECT id,content_format,media_json FROM content_revisions').all() as RevisionRow[];
  const updateRevision = db.prepare('UPDATE content_revisions SET content_media_json=? WHERE id=?');
  db.transaction(() => {
    for (const revision of revisions) {
      let media: MediaSnapshot[] = [];
      try {
        const parsed = JSON.parse(revision.media_json);
        media = Array.isArray(parsed) ? parsed : [];
      } catch {
        media = [];
      }
      const role = roleForFormat(revision.content_format);
      const snapshot = media.map((item, index) => ({
        mediaId: typeof item.id === 'string' ? item.id : null,
        sortOrder: Number.isInteger(item.sort_order) ? item.sort_order : index,
        role,
        previewDurationMs: null
      }));
      updateRevision.run(JSON.stringify(snapshot), revision.id);
    }
  })();

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_content_media_same_post_insert
    BEFORE INSERT ON content_media
    WHEN (SELECT post_id FROM media WHERE id=NEW.media_id) IS NULL
      OR (SELECT post_id FROM media WHERE id=NEW.media_id) <> NEW.post_id
    BEGIN SELECT RAISE(ABORT,'content_media media must belong to the same post'); END;

    CREATE TRIGGER IF NOT EXISTS trg_content_media_same_post_update
    BEFORE UPDATE OF post_id,media_id ON content_media
    WHEN (SELECT post_id FROM media WHERE id=NEW.media_id) IS NULL
      OR (SELECT post_id FROM media WHERE id=NEW.media_id) <> NEW.post_id
    BEGIN SELECT RAISE(ABORT,'content_media media must belong to the same post'); END;

    CREATE TRIGGER IF NOT EXISTS trg_media_insert_content_media
    AFTER INSERT ON media
    WHEN NOT EXISTS (SELECT 1 FROM content_media WHERE media_id=NEW.id)
    BEGIN
      INSERT INTO content_media(id,post_id,media_id,sort_order,role,preview_duration_ms,created_at,updated_at)
      VALUES('cm_' || NEW.id,NEW.post_id,NEW.id,NEW.sort_order,
        CASE
          WHEN (SELECT content_format FROM posts WHERE id=NEW.post_id)='CAROUSEL' THEN 'carousel_item'
          WHEN (SELECT content_format FROM posts WHERE id=NEW.post_id)='STORY_SEQUENCE' THEN 'story_item'
          WHEN (SELECT content_format FROM posts WHERE id=NEW.post_id) IN ('VIDEO','VERTICAL_VIDEO') THEN 'video'
          ELSE 'primary'
        END,NULL,NEW.created_at,NEW.created_at);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_media_order_content_media
    AFTER UPDATE OF sort_order ON media
    BEGIN
      UPDATE content_media SET sort_order=NEW.sort_order,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE media_id=NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_post_format_content_media
    AFTER UPDATE OF publication_kind,content_format ON posts
    BEGIN
      UPDATE content_media SET role=CASE
        WHEN NEW.content_format='CAROUSEL' THEN 'carousel_item'
        WHEN NEW.content_format='STORY_SEQUENCE' THEN 'story_item'
        WHEN NEW.content_format IN ('VIDEO','VERTICAL_VIDEO') THEN 'video'
        ELSE 'primary' END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE post_id=NEW.id AND role<>'poster';
    END;

    CREATE TRIGGER IF NOT EXISTS trg_media_poster_insert
    BEFORE INSERT ON media
    WHEN NEW.poster_asset_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM media poster WHERE poster.id=NEW.poster_asset_id AND poster.post_id=NEW.post_id AND poster.mime_type LIKE 'image/%')
    BEGIN SELECT RAISE(ABORT,'poster asset must be an image from the same post'); END;

    CREATE TRIGGER IF NOT EXISTS trg_media_poster_update
    BEFORE UPDATE OF poster_asset_id ON media
    WHEN NEW.poster_asset_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM media poster WHERE poster.id=NEW.poster_asset_id AND poster.post_id=NEW.post_id AND poster.mime_type LIKE 'image/%')
    BEGIN SELECT RAISE(ABORT,'poster asset must be an image from the same post'); END;

    CREATE TRIGGER IF NOT EXISTS trg_media_delete_clear_poster
    AFTER DELETE ON media
    BEGIN UPDATE media SET poster_asset_id=NULL WHERE poster_asset_id=OLD.id; END;

    CREATE TRIGGER IF NOT EXISTS trg_revision_content_media_snapshot
    AFTER INSERT ON content_revisions
    BEGIN
      UPDATE content_revisions SET content_media_json=COALESCE((
        SELECT json_group_array(json_object(
          'mediaId',media_id,
          'sortOrder',sort_order,
          'role',role,
          'previewDurationMs',preview_duration_ms
        )) FROM (
          SELECT media_id,sort_order,role,preview_duration_ms
          FROM content_media WHERE post_id=NEW.post_id ORDER BY sort_order,created_at
        )
      ),'[]') WHERE id=NEW.id;
    END;
  `);
}
