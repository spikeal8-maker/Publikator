import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from './config.js';
import { db, event, nowIso } from './db.js';
import {
  CONTENT_PLAN_V3_COLUMNS,
  applyContentPlanV3,
  parseContentPlanV3,
  validateContentPlanV3,
  type V3Classification,
  type V3Validation
} from './content-plan-v3.js';
import { readIngestionConnectorCredentials } from './integration-security.js';
import {
  applyGoogleSheetsConnector,
  previewGoogleSheetsConnector,
  type GoogleSheetsPreview
} from './google-sheets.js';
import {
  googleBearerHeaders,
  googleFetchWithTimeout,
  googleServiceAccountAccessToken
} from './google-service-account.js';
import { downloadCloudMedia, refreshCloudMedia, resolveCloudMediaCell, type ResolvedCloudMedia } from './cloud-media.js';
import { deleteMediaVersioned, listMedia, reorderMedia, saveImageVersioned } from './media.js';
import { commitContentEdit } from './content-versioning.js';

const GOOGLE_SHEETS_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';
const READ_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const MAX_SHEET_ROWS = 10_000;
const MEDIA_COLUMN = CONTENT_PLAN_V3_COLUMNS.indexOf('media');
const MAX_IMAGE_DIMENSION = 7680;

type SheetConnectorRow = { id: string; name: string; config_json: string; enabled: number };
type SheetConfig = { spreadsheetId: string; sheetName: string; writeBack: boolean };
type ExistingSourcePost = {
  id: string;
  content_version: number;
  imported_content_version: number | null;
  source_revision: string | null;
  source_payload_hash: string | null;
  status: string;
};

type MediaPreviewItem = {
  source: string;
  path: string;
  provider: ResolvedCloudMedia['provider'];
  connectorId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  revision: string;
};

type EnrichedRow = V3Validation['rows'][number] & {
  mediaPreview?: { managed: boolean; items: MediaPreviewItem[] };
};

export type GoogleSheetsCloudMediaPreview = Omit<V3Validation, 'rows'> & {
  rows: EnrichedRow[];
  connectorId: string;
  spreadsheetId: string;
  sheetName: string;
  sourceSnapshotSha256: string;
  mediaSnapshotSha256: string | null;
  managedMediaRows: number;
};

type DownloadPlan = {
  rowNumber: number;
  postExternalId: string;
  managed: boolean;
  files: Array<{ resolved: ResolvedCloudMedia; tempPath: string; cleanup: () => Promise<void> }>;
};

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function connectorRow(connectorId: string): SheetConnectorRow {
  const row = db.prepare(`SELECT id,name,config_json,enabled FROM ingestion_connectors
    WHERE id=? AND type='google_sheets'`).get(connectorId) as SheetConnectorRow | undefined;
  if (!row || !row.enabled) throw new Error('Enabled Google Sheets connector not found');
  return row;
}

function sheetConfig(row: SheetConnectorRow): SheetConfig {
  const parsed = JSON.parse(row.config_json) as Record<string, unknown>;
  const spreadsheetId = String(parsed.spreadsheetId ?? '').trim();
  const sheetName = String(parsed.sheetName ?? '').trim();
  if (!spreadsheetId || !sheetName) throw new Error('Google Sheets connector config is invalid');
  return { spreadsheetId, sheetName, writeBack: parsed.writeBack === true };
}

function quoteSheetName(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function valuesToCsv(values: unknown[][], stripMedia: boolean): Buffer {
  const rows = values.map((input, rowIndex) => {
    const row = input.slice(0, CONTENT_PLAN_V3_COLUMNS.length);
    while (row.length < CONTENT_PLAN_V3_COLUMNS.length) row.push('');
    if (stripMedia && rowIndex > 0 && MEDIA_COLUMN >= 0) row[MEDIA_COLUMN] = '';
    return row.map(csvCell).join(',');
  });
  return Buffer.from(`${rows.join('\n')}\n`, 'utf8');
}

function sourceId(connectorId: string): string {
  return `gs:${connectorId}`;
}

function sourceRef(connectorId: string, externalId: string): string {
  return JSON.stringify([sourceId(connectorId), externalId]);
}

function rawMediaCell(values: unknown[][], rowNumber: number): string {
  const row = values[rowNumber - 1] ?? [];
  return String(row[MEDIA_COLUMN] ?? '').trim();
}

function hasCloudMediaInput(values: unknown[][]): boolean {
  if (MEDIA_COLUMN < 0) return false;
  for (let index = 1; index < values.length; index += 1) {
    const row = values[index] ?? [];
    if (String(row[MEDIA_COLUMN] ?? '').trim()) return true;
  }
  return false;
}

function sourceAction(values: unknown[][]): void {
  for (let index = 1; index < values.length; index += 1) {
    const row = values[index] ?? [];
    if (row.every((item) => String(item ?? '').trim() === '')) continue;
    const action = String(row[2] ?? '').trim().toUpperCase();
    if (action !== 'UPSERT') throw new Error('Google Sheets sync currently accepts action=UPSERT only; row deletion never deletes a Publikator post');
  }
}

async function sheetValues(connectorId: string): Promise<{ config: SheetConfig; credentials: Record<string, unknown>; values: unknown[][] }> {
  const row = connectorRow(connectorId);
  const cfg = sheetConfig(row);
  const credentials = readIngestionConnectorCredentials(connectorId);
  const token = await googleServiceAccountAccessToken(credentials, READ_SCOPE);
  const range = `${quoteSheetName(cfg.sheetName)}!A1:U${MAX_SHEET_ROWS + 1}`;
  const url = `${GOOGLE_SHEETS_ROOT}/${encodeURIComponent(cfg.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  const response = await googleFetchWithTimeout(url, { headers: googleBearerHeaders(token) });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(`Google Sheets values request failed (HTTP ${response.status})`);
  const values = Array.isArray(payload.values) ? payload.values as unknown[][] : [];
  if (values.length > MAX_SHEET_ROWS + 1) throw new Error(`Google Sheet has more than ${MAX_SHEET_ROWS} data rows`);
  return { config: cfg, credentials, values };
}

function mediaManifestItem(item: ResolvedCloudMedia): MediaPreviewItem {
  return {
    source: item.connectorName,
    path: item.path,
    provider: item.provider,
    connectorId: item.connectorId,
    fileId: item.fileId,
    fileName: item.fileName,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    revision: item.revision
  };
}

function counts(rows: EnrichedRow[]): V3Validation['summary'] {
  const count = (kind: V3Classification) => rows.filter((row) => row.classification === kind).length;
  return {
    totalRows: rows.length,
    newRows: count('NEW'),
    updateRows: count('UPDATE'),
    unchangedRows: count('UNCHANGED'),
    conflicts: count('CONFLICT'),
    requests: count('ARCHIVE_REQUEST') + count('TRASH_REQUEST'),
    errors: count('ERROR')
  };
}

function currentSourcePost(connectorId: string, externalId: string): ExistingSourcePost | undefined {
  return db.prepare(`SELECT id,content_version,imported_content_version,source_revision,source_payload_hash,status
    FROM posts WHERE source_type='google_sheets' AND source_ref=?`).get(sourceRef(connectorId, externalId)) as ExistingSourcePost | undefined;
}

async function previewFromValues(connectorId: string, configValue: SheetConfig, values: unknown[][]): Promise<GoogleSheetsCloudMediaPreview> {
  sourceAction(values);
  const sourceSnapshotSha256 = sha256(valuesToCsv(values, false));
  const parsed = await parseContentPlanV3('google-sheet.csv', valuesToCsv(values, true));
  const base = await validateContentPlanV3(parsed, sourceId(connectorId));
  const rows: EnrichedRow[] = [];
  const manifest: Array<{ rowNumber: number; items: MediaPreviewItem[] }> = [];

  for (const input of base.rows) {
    if (!input.normalized) { rows.push(input); continue; }
    const normalized: any = { ...input.normalized };
    let mediaPreview: { managed: boolean; items: MediaPreviewItem[] } = { managed: false, items: [] };
    try {
      const resolved = await resolveCloudMediaCell(rawMediaCell(values, input.rowNumber));
      mediaPreview = { managed: resolved.managed, items: resolved.resolved.map(mediaManifestItem) };
      if (resolved.managed) {
        manifest.push({ rowNumber: input.rowNumber, items: mediaPreview.items });
        normalized.payloadHash = sha256(JSON.stringify({ base: normalized.payloadHash, media: mediaPreview.items }));
      }
    } catch (error) {
      rows.push({
        ...input,
        classification: 'ERROR',
        errors: [...input.errors, error instanceof Error ? error.message : String(error)],
        normalized: null,
        mediaPreview
      });
      continue;
    }

    const existing = currentSourcePost(connectorId, normalized.externalId);
    let classification: V3Classification;
    const errors = [...input.errors];
    if (!existing) {
      classification = 'NEW';
      normalized.postId = null;
      normalized.importedContentVersion = null;
    } else {
      normalized.postId = existing.id;
      normalized.importedContentVersion = existing.imported_content_version;
      const editable = ['DRAFT', 'READY', 'FAILED'].includes(existing.status);
      const diverged = existing.imported_content_version == null || existing.content_version !== existing.imported_content_version;
      const payloadUnchanged = existing.source_payload_hash === normalized.payloadHash;
      const currentMediaCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM media
        WHERE post_id=? AND (poster_asset_id IS NULL OR mime_type NOT LIKE 'image/%')`).get(existing.id) as { count: number }).count);
      const managedMediaMissing = mediaPreview.managed && currentMediaCount !== mediaPreview.items.length;

      if (!editable && !payloadUnchanged) {
        classification = 'ERROR';
        errors.push(`Post status=${existing.status} is immutable for Google Sheets sync`);
      } else if (editable && diverged) {
        classification = 'CONFLICT';
      } else if (payloadUnchanged && !managedMediaMissing) {
        classification = 'UNCHANGED';
      } else if (existing.source_revision === normalized.sourceRevision && !managedMediaMissing) {
        classification = 'ERROR';
        errors.push('source_revision was reused with a different payload');
      } else {
        classification = 'UPDATE';
      }
    }
    normalized.classification = classification;
    rows.push({ ...input, classification, errors, normalized, mediaPreview });
  }

  const summary = counts(rows);
  const mediaSnapshotSha256 = manifest.length ? sha256(JSON.stringify(manifest)) : null;
  return {
    ...base,
    fileSha256: sourceSnapshotSha256,
    rows,
    summary,
    canApply: summary.errors === 0 && summary.conflicts === 0,
    connectorId,
    spreadsheetId: configValue.spreadsheetId,
    sheetName: configValue.sheetName,
    sourceSnapshotSha256,
    mediaSnapshotSha256,
    managedMediaRows: manifest.length
  };
}

export async function previewGoogleSheetsCloudMedia(connectorId: string): Promise<GoogleSheetsCloudMediaPreview | GoogleSheetsPreview> {
  const { config: cfg, values } = await sheetValues(connectorId);
  if (!hasCloudMediaInput(values)) return previewGoogleSheetsConnector(connectorId);
  return previewFromValues(connectorId, cfg, values);
}

async function validateDownloadedImage(tempPath: string): Promise<void> {
  const source = sharp(tempPath, { failOn: 'error' }).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Cloud media file is not a valid image');
  if (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION) throw new Error(`Cloud image exceeds ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}`);
  const normalized = await source.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  if (normalized.byteLength > config.maxImageBytes) throw new Error(`Normalized cloud image exceeds ${config.maxImageBytes} bytes`);
}

async function prepareDownloads(preview: GoogleSheetsCloudMediaPreview): Promise<DownloadPlan[]> {
  const plans: DownloadPlan[] = [];
  try {
    for (const row of preview.rows) {
      const normalized: any = row.normalized;
      if (!normalized || !row.mediaPreview?.managed || !['NEW', 'UPDATE'].includes(row.classification)) continue;
      const files: DownloadPlan['files'] = [];
      for (const item of row.mediaPreview.items) {
        if (item.provider !== 'google_drive' && item.provider !== 'yandex_disk') {
          throw new Error(`Unsupported cloud media provider: ${item.provider}`);
        }
        const resolved = {
          provider: item.provider,
          connectorId: item.connectorId,
          connectorName: item.source,
          path: item.path,
          fileId: item.fileId,
          fileName: item.fileName,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          revision: item.revision
        } as ResolvedCloudMedia;
        const downloaded = await downloadCloudMedia(resolved);
        await validateDownloadedImage(downloaded.tempPath);
        const after = await refreshCloudMedia(resolved);
        if (after.fileId !== resolved.fileId || after.revision !== resolved.revision || after.sizeBytes !== resolved.sizeBytes) {
          await downloaded.cleanup();
          throw new Error(`Cloud media changed after preview: ${item.source}/${item.path}`);
        }
        files.push({ resolved, tempPath: downloaded.tempPath, cleanup: downloaded.cleanup });
      }
      plans.push({ rowNumber: row.rowNumber, postExternalId: normalized.externalId, managed: true, files });
    }
    return plans;
  } catch (error) {
    await Promise.all(plans.flatMap((plan) => plan.files.map((file) => file.cleanup()))).catch(() => undefined);
    throw error;
  }
}

function forceGoogleSource(preview: GoogleSheetsCloudMediaPreview, postIds: string[]): void {
  const refs = new Set(preview.rows.filter((row) => row.normalized).map((row) => sourceRef(preview.connectorId, (row.normalized as any).externalId)));
  for (const postId of postIds) {
    const row = db.prepare('SELECT source_ref,source_type FROM posts WHERE id=?').get(postId) as { source_ref: string | null; source_type: string | null } | undefined;
    if (row?.source_type === 'content-plan-v3' && row.source_ref && refs.has(row.source_ref)) {
      db.prepare("UPDATE posts SET source_type='google_sheets' WHERE id=?").run(postId);
    }
  }
}

function postForExternalId(connectorId: string, externalId: string): { id: string; content_version: number } {
  const post = db.prepare("SELECT id,content_version FROM posts WHERE source_type='google_sheets' AND source_ref=?")
    .get(sourceRef(connectorId, externalId)) as { id: string; content_version: number } | undefined;
  if (!post) throw new Error(`Imported Google Sheets post not found: ${externalId}`);
  return post;
}

async function syncImagePlan(postId: string, files: DownloadPlan['files']): Promise<number> {
  let version = (db.prepare('SELECT content_version FROM posts WHERE id=?').get(postId) as { content_version: number }).content_version;
  const desiredIds: string[] = [];
  const beforeIds = new Set(listMedia(postId).map((row) => row.id));
  const addedIds: string[] = [];
  try {
    for (const file of files) {
      const buffer = await fs.readFile(file.tempPath);
      const saved = await saveImageVersioned(postId, file.resolved.fileName, buffer, version);
      version = saved.contentVersion;
      desiredIds.push(saved.media.id);
      if (!beforeIds.has(saved.media.id)) addedIds.push(saved.media.id);
    }
  } catch (error) {
    for (const mediaId of addedIds.reverse()) {
      try {
        const current = db.prepare('SELECT content_version FROM posts WHERE id=?').get(postId) as { content_version: number };
        await deleteMediaVersioned(mediaId, current.content_version);
      } catch { /* preserve the original error; next preview remains non-authoritative */ }
    }
    throw error;
  }

  const desired = new Set(desiredIds);
  while (true) {
    const current = listMedia(postId);
    const extra = current.find((item) => item.mime_type.startsWith('video/') && !desired.has(item.id))
      ?? current.find((item) => !desired.has(item.id));
    if (!extra) break;
    const result = await deleteMediaVersioned(extra.id, version);
    version = result.contentVersion;
  }

  const ordered = listMedia(postId).map((row) => row.id);
  if (ordered.length !== desiredIds.length || ordered.some((id, index) => id !== desiredIds[index])) {
    const committed = commitContentEdit(postId, version, () => reorderMedia(postId, desiredIds));
    version = committed.contentVersion;
  }
  return version;
}

async function writeBack(connectorId: string, cfg: SheetConfig, credentials: Record<string, unknown>, preview: GoogleSheetsCloudMediaPreview): Promise<void> {
  if (!cfg.writeBack) return;
  const token = await googleServiceAccountAccessToken(credentials, WRITE_SCOPE);
  const data: Array<{ range: string; majorDimension: 'ROWS'; values: string[][] }> = [{
    range: `${quoteSheetName(cfg.sheetName)}!V1:Y1`, majorDimension: 'ROWS',
    values: [['publikator_id', 'import_status', 'imported_at', 'last_error']]
  }];
  const importedAt = nowIso();
  for (const item of preview.rows) {
    const normalized: any = item.normalized;
    if (!normalized) continue;
    const post = db.prepare("SELECT id FROM posts WHERE source_type='google_sheets' AND source_ref=?")
      .get(sourceRef(connectorId, normalized.externalId)) as { id: string } | undefined;
    data.push({
      range: `${quoteSheetName(cfg.sheetName)}!V${item.rowNumber}:Y${item.rowNumber}`,
      majorDimension: 'ROWS', values: [[post?.id ?? '', item.classification, importedAt, '']]
    });
  }
  const response = await googleFetchWithTimeout(`${GOOGLE_SHEETS_ROOT}/${encodeURIComponent(cfg.spreadsheetId)}/values:batchUpdate`, {
    method: 'POST', headers: { ...googleBearerHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data })
  });
  if (!response.ok) throw new Error(`Google Sheets status write-back failed (HTTP ${response.status})`);
}

export async function applyGoogleSheetsCloudMedia(connectorId: string, expectedSnapshotSha256: string, expectedMediaSnapshotSha256?: string | null): Promise<
  Awaited<ReturnType<typeof applyGoogleSheetsConnector>> | {
    created: number; updated: number; unchanged: number; archived: number; trashed: number; postIds: string[];
    sourceSnapshotSha256: string; mediaSnapshotSha256: string | null;
    media: { managedRows: number; syncedRows: number };
    writeBack: { attempted: boolean; ok: boolean; error: string | null };
  }
> {
  if (!/^[a-f0-9]{64}$/i.test(expectedSnapshotSha256)) throw new Error('A preview SHA-256 is required');
  if (!expectedMediaSnapshotSha256) {
    const { values } = await sheetValues(connectorId);
    if (!hasCloudMediaInput(values)) return applyGoogleSheetsConnector(connectorId, expectedSnapshotSha256);
    throw new Error('Cloud media preview SHA-256 is required; preview again before apply');
  }
  const { config: cfg, credentials, values } = await sheetValues(connectorId);
  const preview = await previewFromValues(connectorId, cfg, values);
  if (preview.sourceSnapshotSha256 !== expectedSnapshotSha256.toLowerCase()) throw new Error('Google Sheet changed after preview; preview again before apply');
  if (preview.managedMediaRows > 0) {
    if (!expectedMediaSnapshotSha256 || preview.mediaSnapshotSha256 !== expectedMediaSnapshotSha256.toLowerCase()) {
      throw new Error('Cloud media changed or was not confirmed after preview; preview again before apply');
    }
  }
  if (!preview.canApply) throw new Error('Google Sheets preview contains ERROR/CONFLICT');

  const downloads = await prepareDownloads(preview);
  let result: ReturnType<typeof applyContentPlanV3>;
  let syncedRows = 0;
  try {
    result = applyContentPlanV3(preview);
    forceGoogleSource(preview, result.postIds);
    const planByRow = new Map(downloads.map((plan) => [plan.rowNumber, plan]));
    for (const row of preview.rows) {
      const normalized: any = row.normalized;
      if (!normalized || !row.mediaPreview?.managed || !['NEW', 'UPDATE'].includes(row.classification)) continue;
      const post = postForExternalId(connectorId, normalized.externalId);
      const plan = planByRow.get(row.rowNumber) ?? { rowNumber: row.rowNumber, postExternalId: normalized.externalId, managed: true, files: [] };
      try {
        const finalVersion = await syncImagePlan(post.id, plan.files);
        db.prepare('UPDATE posts SET imported_content_version=? WHERE id=?').run(finalVersion, post.id);
        syncedRows += 1;
      } catch (error) {
        const current = db.prepare('SELECT content_version FROM posts WHERE id=?').get(post.id) as { content_version: number };
        db.prepare('UPDATE posts SET source_revision=NULL,source_payload_hash=NULL,imported_content_version=? WHERE id=?')
          .run(current.content_version, post.id);
        event({ level: 'error', postId: post.id, type: 'cloud_media.apply_failed', message: error instanceof Error ? error.message : String(error), data: { connectorId, externalId: normalized.externalId } });
        throw error;
      }
    }
  } finally {
    await Promise.all(downloads.flatMap((plan) => plan.files.map((file) => file.cleanup()))).catch(() => undefined);
  }

  event({
    type: 'google_sheets.cloud_media_applied',
    message: `Google Sheets + cloud media sync applied: ${preview.rows.length} rows`,
    data: { connectorId, spreadsheetId: cfg.spreadsheetId, managedMediaRows: preview.managedMediaRows, syncedRows, ...result! }
  });

  const writeBackResult = { attempted: cfg.writeBack, ok: true, error: null as string | null };
  if (cfg.writeBack) {
    try { await writeBack(connectorId, cfg, credentials, preview); }
    catch (error) {
      writeBackResult.ok = false;
      writeBackResult.error = error instanceof Error ? error.message : String(error);
      event({ level: 'warning', type: 'google_sheets.writeback_failed', message: writeBackResult.error, data: { connectorId } });
    }
  }
  return {
    ...result!,
    sourceSnapshotSha256: preview.sourceSnapshotSha256,
    mediaSnapshotSha256: preview.mediaSnapshotSha256,
    media: { managedRows: preview.managedMediaRows, syncedRows },
    writeBack: writeBackResult
  };
}
