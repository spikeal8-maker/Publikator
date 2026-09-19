import { db, id, nowIso } from './db.js';
import type { ContentFormat, PublicationKind } from './domain/content-domain.js';
import { commitContentEdit } from './content-versioning.js';
import { parseRichTextJson, richTextToPlain, serializeRichText } from './rich-text.js';

export type CanonicalRendition = {
  textRichJson: string | null;
  textPlain: string;
  publicationKind: PublicationKind;
  contentFormat: ContentFormat;
  mediaPlanJson: string;
  optionsJson: string;
};

export type TargetRenditionOverride = {
  textRichJson?: string | null;
  textPlain?: string | null;
  publicationKind?: PublicationKind | null;
  contentFormat?: ContentFormat | null;
  mediaPlanJson?: string | null;
  optionsJson?: string | null;
};

export function resolveTargetRendition(
  canonical: CanonicalRendition,
  override: TargetRenditionOverride | null | undefined
): CanonicalRendition {
  return {
    textRichJson: override?.textRichJson ?? canonical.textRichJson,
    textPlain: override?.textPlain ?? canonical.textPlain,
    publicationKind: override?.publicationKind ?? canonical.publicationKind,
    contentFormat: override?.contentFormat ?? canonical.contentFormat,
    mediaPlanJson: override?.mediaPlanJson ?? canonical.mediaPlanJson,
    optionsJson: override?.optionsJson ?? canonical.optionsJson
  };
}
const PUBLICATION_KINDS = new Set<PublicationKind>(['FEED', 'SHORT', 'STORY']);
const CONTENT_FORMATS = new Set<ContentFormat>(['TEXT_ONLY', 'IMAGE', 'CAROUSEL', 'VIDEO', 'VERTICAL_VIDEO', 'STORY_SEQUENCE']);

function jsonOrNull(value: string | null | undefined, label: string): string | null {
  if (value == null || value === '') return null;
  try { JSON.parse(value); } catch { throw new Error(`${label} must contain valid JSON`); }
  return value;
}

function canonicalRichTextOrNull(value: string | null | undefined): { json: string; plain: string } | null {
  if (value == null || value === '') return null;
  const document = parseRichTextJson(value);
  return { json: serializeRichText(document), plain: richTextToPlain(document) };
}


export function saveTargetRendition(targetId: string, override: TargetRenditionOverride, expectedContentVersion: number): { contentVersion: number } {
  const target = db.prepare('SELECT post_id FROM post_targets WHERE id=?').get(targetId) as { post_id: string } | undefined;
  if (!target) throw new Error('Target not found');
  if (override.publicationKind && !PUBLICATION_KINDS.has(override.publicationKind)) throw new Error('Unsupported publication kind');
  if (override.contentFormat && !CONTENT_FORMATS.has(override.contentFormat)) throw new Error('Unsupported content format');
  const rich = canonicalRichTextOrNull(override.textRichJson);
  const media = jsonOrNull(override.mediaPlanJson, 'mediaPlanJson');
  const options = jsonOrNull(override.optionsJson, 'optionsJson');
  const committed = commitContentEdit(target.post_id, expectedContentVersion, 'manual', () => {
    db.prepare(`INSERT INTO target_renditions
      (target_id,text_rich_json,text_plain,publication_kind,content_format,media_plan_json,options_json,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(target_id) DO UPDATE SET
        text_rich_json=excluded.text_rich_json,text_plain=excluded.text_plain,
        publication_kind=excluded.publication_kind,content_format=excluded.content_format,
        media_plan_json=excluded.media_plan_json,options_json=excluded.options_json,updated_at=excluded.updated_at`)
      .run(targetId, rich?.json ?? null, rich?.plain ?? override.textPlain ?? null, override.publicationKind ?? null,
        override.contentFormat ?? null, media, options, nowIso());
  });
  return { contentVersion: committed.contentVersion };
}

export function getTargetRendition(targetId: string): TargetRenditionOverride | null {
  const row = db.prepare('SELECT * FROM target_renditions WHERE target_id=?').get(targetId) as any;
  if (!row) return null;
  return { textRichJson: row.text_rich_json, textPlain: row.text_plain,
    publicationKind: row.publication_kind, contentFormat: row.content_format,
    mediaPlanJson: row.media_plan_json, optionsJson: row.options_json };
}
export type PublicationUnitState = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'RETRY' | 'FAILED' | 'RECOVERY_NEEDED';
export type PublicationUnitType = 'POST' | 'MEDIA_GROUP' | 'STORY';

export type PublicationUnitRow = {
  id: string;
  target_id: string;
  revision_id: string;
  unit_index: number;
  unit_type: PublicationUnitType;
  state: PublicationUnitState;
  attempts: number;
  external_id: string | null;
  external_url: string | null;
  last_error: string | null;
  published_at: string | null;
  updated_at: string;
};

export function ensurePublicationUnits(targetId: string, revisionId: string, unitTypes: PublicationUnitType[]): PublicationUnitRow[] {
  if (unitTypes.length === 0) throw new Error('At least one publication unit is required');
  const target = db.prepare('SELECT post_id FROM post_targets WHERE id=?').get(targetId) as { post_id: string } | undefined;
  if (!target) throw new Error('Target not found');
  const revision = db.prepare('SELECT post_id FROM content_revisions WHERE id=?').get(revisionId) as { post_id: string } | undefined;
  if (!revision) throw new Error('Revision not found');
  if (target.post_id !== revision.post_id) throw new Error('Publication unit revision must belong to the same post as target');
  const existing = db.prepare('SELECT * FROM publication_units WHERE target_id=? ORDER BY unit_index').all(targetId) as PublicationUnitRow[];
  if (existing.length > 0) {
    const same = existing.length === unitTypes.length && existing.every((row, index) =>
      row.revision_id === revisionId && row.unit_index === index && row.unit_type === unitTypes[index]);
    if (!same) throw new Error('Publication units already exist with a different immutable plan');
    return existing;
  }
  const insert = db.prepare(`INSERT INTO publication_units
    (id,target_id,revision_id,unit_index,unit_type,state,attempts,updated_at)
    VALUES (?,?,?,?,?,'PENDING',0,?)`);
  db.transaction(() => unitTypes.forEach((type, index) => insert.run(id('unit'), targetId, revisionId, index, type, nowIso())))();
  syncAggregateTargetState(targetId);
  return listPublicationUnits(targetId);
}
export function listPublicationUnits(targetId: string): PublicationUnitRow[] {
  return db.prepare('SELECT * FROM publication_units WHERE target_id=? ORDER BY unit_index').all(targetId) as PublicationUnitRow[];
}

function aggregateUnitState(rows: PublicationUnitRow[]): string {
  if (rows.some((row) => row.state === 'RECOVERY_NEEDED')) return 'RECOVERY_NEEDED';
  if (rows.length > 0 && rows.every((row) => row.state === 'PUBLISHED')) return 'PUBLISHED';
  if (rows.some((row) => row.state === 'PUBLISHED')) return 'PARTIAL';
  if (rows.some((row) => row.state === 'PUBLISHING')) return 'PUBLISHING';
  if (rows.some((row) => row.state === 'RETRY')) return 'RETRY';
  if (rows.some((row) => row.state === 'FAILED')) return 'FAILED';
  return 'PENDING';
}

export function syncAggregateTargetState(targetId: string): string {
  const rows = listPublicationUnits(targetId);
  if (rows.length === 0) return 'PENDING';
  const state = aggregateUnitState(rows);
  db.prepare('UPDATE post_targets SET state=?,updated_at=? WHERE id=?').run(state, nowIso(), targetId);
  return state;
}

export function claimNextPublicationUnit(targetId: string): PublicationUnitRow | null {
  const rows = listPublicationUnits(targetId);
  const candidate = rows.find((row) => row.state !== 'PUBLISHED');
  if (!candidate) return null;
  if (candidate.state === 'RECOVERY_NEEDED' || candidate.state === 'PUBLISHING') {
    throw new Error('Sequence has an unresolved or in-flight publication unit');
  }
  if (candidate.state === 'FAILED') throw new Error('Failed publication unit must be explicitly retried before sequence can continue');
  if (!['PENDING','RETRY'].includes(candidate.state)) throw new Error(`Publication unit cannot be claimed from state ${candidate.state}`);
  const changed = db.prepare(`UPDATE publication_units SET state='PUBLISHING',attempts=attempts+1,updated_at=?
    WHERE id=? AND state IN ('PENDING','RETRY')`).run(nowIso(), candidate.id);
  if (changed.changes !== 1) throw new Error('Publication unit claim lost a concurrency race');
  syncAggregateTargetState(targetId);
  return db.prepare('SELECT * FROM publication_units WHERE id=?').get(candidate.id) as PublicationUnitRow;
}
export function markPublicationUnitPublished(unitId: string, externalId: string, externalUrl?: string | null): void {
  const row = db.prepare('SELECT target_id,state FROM publication_units WHERE id=?').get(unitId) as { target_id: string; state: string } | undefined;
  if (!row) throw new Error('Publication unit not found');
  if (!['PUBLISHING','RECOVERY_NEEDED'].includes(row.state)) throw new Error('Publication unit is not awaiting a public outcome');
  db.prepare(`UPDATE publication_units SET state='PUBLISHED',external_id=?,external_url=?,last_error=NULL,published_at=?,updated_at=? WHERE id=?`)
    .run(externalId, externalUrl ?? null, nowIso(), nowIso(), unitId);
  syncAggregateTargetState(row.target_id);
}

export function markPublicationUnitRecoveryNeeded(unitId: string, error: string): void {
  const row = db.prepare('SELECT target_id,state FROM publication_units WHERE id=?').get(unitId) as { target_id: string; state: string } | undefined;
  if (!row) throw new Error('Publication unit not found');
  if (row.state !== 'PUBLISHING') throw new Error('Only an in-flight publication unit can enter recovery');
  db.prepare("UPDATE publication_units SET state='RECOVERY_NEEDED',last_error=?,updated_at=? WHERE id=?")
    .run(error, nowIso(), unitId);
  syncAggregateTargetState(row.target_id);
}

export function confirmPublicationUnitNotPublished(unitId: string): void {
  const row = db.prepare('SELECT target_id,state FROM publication_units WHERE id=?').get(unitId) as { target_id: string; state: string } | undefined;
  if (!row) throw new Error('Publication unit not found');
  if (row.state !== 'RECOVERY_NEEDED') throw new Error('Publication unit is not in recovery');
  db.prepare("UPDATE publication_units SET state='RETRY',last_error=NULL,updated_at=? WHERE id=?").run(nowIso(), unitId);
  syncAggregateTargetState(row.target_id);
}


export function retryFailedPublicationUnit(unitId: string): void {
  const row = db.prepare('SELECT target_id,state FROM publication_units WHERE id=?').get(unitId) as { target_id: string; state: string } | undefined;
  if (!row) throw new Error('Publication unit not found');
  if (row.state !== 'FAILED') throw new Error('Only a failed publication unit can be retried');
  db.prepare("UPDATE publication_units SET state='RETRY',last_error=NULL,updated_at=? WHERE id=?").run(nowIso(), unitId);
  syncAggregateTargetState(row.target_id);
}

export function markPublicationUnitFailed(unitId: string, error: string): void {
  const row = db.prepare('SELECT target_id,state FROM publication_units WHERE id=?').get(unitId) as { target_id: string; state: string } | undefined;
  if (!row) throw new Error('Publication unit not found');
  if (row.state !== 'PUBLISHING') throw new Error('Only an in-flight publication unit can fail');
  db.prepare("UPDATE publication_units SET state='FAILED',last_error=?,updated_at=? WHERE id=?").run(error, nowIso(), unitId);
  syncAggregateTargetState(row.target_id);
}
