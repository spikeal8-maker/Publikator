import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { db, event, id, nowIso } from './db.js';
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
  applyGoogleSheetsValues,
  previewGoogleSheetsValues,
  type GoogleSheetsPreview
} from './google-sheets.js';
import {
  googleBearerHeaders,
  googleFetchWithTimeout,
  googleServiceAccountAccessToken
} from './google-service-account.js';
import { downloadCloudMedia, refreshCloudMedia, resolveCloudMediaCell, type ResolvedCloudMedia } from './cloud-media.js';
import { listMedia, type MediaRow } from './media.js';
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
  if (!hasCloudMediaInput(values)) return previewGoogleSheetsValues(connectorId, values);
  return previewFromValues(connectorId, cfg, values);
}

type PreparedCloudImage = {
  data: Buffer;
  width: number;
  height: number;
  sha256: string;
};
type StagedMediaFile = {
  mediaId: string;
  originalName: string;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  width: number;
  height: number;
  sha256: string;
};
type AtomicMediaPlan = {
  rowNumber: number;
  externalId: string;
  postId: string;
  replace: boolean;
  staged: StagedMediaFile[];
  previous: MediaRow[];
};

async function prepareDownloadedImage(tempPath: string): Promise<PreparedCloudImage> {
  const source = sharp(tempPath, { failOn: 'error' }).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Cloud media file is not a valid image');
  if (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION) {
    throw new Error(`Cloud image exceeds ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}`);
  }
  const result = await source.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  if (result.data.byteLength > config.maxImageBytes) throw new Error(`Normalized cloud image exceeds ${config.maxImageBytes} bytes`);
  return {
    data: result.data,
    width: result.info.width,
    height: result.info.height,
    sha256: crypto.createHash('sha256').update(result.data).digest('hex')
  };
}

async function prepareDownloads(preview: GoogleSheetsCloudMediaPreview): Promise<DownloadPlan[]> {
  const plans: DownloadPlan[] = [];
  try {
    for (const row of preview.rows) {
      const normalized: any = row.normalized;
      if (!normalized || !row.mediaPreview?.managed || !['NEW', 'UPDATE'].includes(row.classification)) continue;
      const files: DownloadPlan['files'] = [];
      for (const item of row.mediaPreview.items) {
        if (item.provider !== 'google_drive' && item.provider !== 'yandex_disk') throw new Error(`Unsupported cloud media provider: ${item.provider}`);
        const resolved = { provider: item.provider, connectorId: item.connectorId, connectorName: item.source, path: item.path,
          fileId: item.fileId, fileName: item.fileName, mimeType: item.mimeType, sizeBytes: item.sizeBytes, revision: item.revision } as ResolvedCloudMedia;
        const downloaded = await downloadCloudMedia(resolved);
        await prepareDownloadedImage(downloaded.tempPath);
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

async function stageAtomicMediaPlans(
  preview: GoogleSheetsCloudMediaPreview,
  downloads: DownloadPlan[]
): Promise<{ plans: AtomicMediaPlan[]; newPostIds: Map<string, string> }> {
  const newPostIds = new Map<string, string>();
  for (const row of preview.rows) {
    const normalized: any = row.normalized;
    if (normalized && row.classification === 'NEW' && row.mediaPreview?.managed) newPostIds.set(normalized.externalId, id('post'));
  }
  const downloadByRow = new Map(downloads.map((plan) => [plan.rowNumber, plan]));
  const plans: AtomicMediaPlan[] = [];
  try {
    for (const row of preview.rows) {
      const normalized: any = row.normalized;
      if (!normalized || !row.mediaPreview?.managed || !['NEW', 'UPDATE'].includes(row.classification)) continue;
      const postId = normalized.postId || newPostIds.get(normalized.externalId);
      if (!postId) throw new Error(`Cloud media staging lost post identity: ${normalized.externalId}`);
      const download = downloadByRow.get(row.rowNumber) ?? { rowNumber: row.rowNumber, postExternalId: normalized.externalId, managed: true, files: [] };
      const prepared: Array<{ file: DownloadPlan['files'][number]; image: PreparedCloudImage }> = [];
      for (const file of download.files) prepared.push({ file, image: await prepareDownloadedImage(file.tempPath) });
      const previous = normalized.postId ? listMedia(postId) : [];
      const same = previous.length === prepared.length && previous.every((media, index) =>
        media.mime_type === 'image/jpeg' && media.sha256 === prepared[index]?.image.sha256);
      const staged: StagedMediaFile[] = [];
      if (!same) {
        await fs.mkdir(path.join(config.mediaDir, postId), { recursive: true });
        for (const item of prepared) {
          const mediaId = id('med');
          const relativePath = path.posix.join(postId, `${mediaId}.jpg`);
          const absolutePath = path.join(config.mediaDir, relativePath);
          await fs.writeFile(absolutePath, item.image.data, { flag: 'wx' });
          staged.push({ mediaId, originalName: item.file.resolved.fileName, relativePath, absolutePath,
            sizeBytes: item.image.data.byteLength, width: item.image.width, height: item.image.height, sha256: item.image.sha256 });
        }
      }
      plans.push({ rowNumber: row.rowNumber, externalId: normalized.externalId, postId, replace: !same, staged, previous });
    }
    return { plans, newPostIds };
  } catch (error) {
    await Promise.all(plans.flatMap((plan) => plan.staged.map((file) => fs.rm(file.absolutePath, { force: true })))).catch(() => undefined);
    throw error;
  }
}

function applyAtomicMediaPlan(plan: AtomicMediaPlan): void {
  if (!plan.replace) return;
  const current = db.prepare('SELECT content_version FROM posts WHERE id=?').get(plan.postId) as { content_version: number } | undefined;
  if (!current) throw new Error(`Cloud media post disappeared during apply: ${plan.externalId}`);
  commitContentEdit(plan.postId, current.content_version, 'google_sheets', () => {
    db.prepare('DELETE FROM media WHERE post_id=?').run(plan.postId);
    const createdAt = nowIso();
    const insert = db.prepare(`INSERT INTO media
      (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    plan.staged.forEach((file, index) => insert.run(
      file.mediaId, plan.postId, file.originalName, file.relativePath, 'image/jpeg', file.sizeBytes,
      file.width, file.height, file.sha256, createdAt, index
    ));
    // publication_kind/content_format are canonical source-row fields owned by content-plan-v3.
    // Cloud media localization must not rewrite the editorial contract.
  });
}

async function cleanupStagedFiles(plans: AtomicMediaPlan[]): Promise<void> {
  await Promise.all(plans.flatMap((plan) => plan.staged.map((file) => fs.rm(file.absolutePath, { force: true })))).catch(() => undefined);
}

async function cleanupPreviousFiles(plans: AtomicMediaPlan[], connectorId: string): Promise<void> {
  for (const plan of plans.filter((item) => item.replace)) {
    for (const media of plan.previous) {
      try { await fs.rm(path.join(config.mediaDir, media.relative_path), { force: true }); }
      catch (error) {
        event({ level: 'warning', type: 'cloud_media.orphan_cleanup_failed', message: error instanceof Error ? error.message : String(error),
          data: { connectorId, postId: plan.postId, mediaId: media.id, relativePath: media.relative_path } });
      }
    }
  }
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
  Awaited<ReturnType<typeof applyGoogleSheetsValues>> | {
    created: number; updated: number; unchanged: number; archived: number; trashed: number; postIds: string[];
    sourceSnapshotSha256: string; mediaSnapshotSha256: string | null;
    media: { managedRows: number; syncedRows: number };
    writeBack: { attempted: boolean; ok: boolean; error: string | null };
  }
> {
  if (!/^[a-f0-9]{64}$/i.test(expectedSnapshotSha256)) throw new Error('A preview SHA-256 is required');
  if (!expectedMediaSnapshotSha256) {
    const { values } = await sheetValues(connectorId);
    if (!hasCloudMediaInput(values)) return applyGoogleSheetsValues(connectorId, expectedSnapshotSha256, values);
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
  let atomicPlans: AtomicMediaPlan[] = [];
  let result: ReturnType<typeof applyContentPlanV3>;
  let syncedRows = 0;
  let committed = false;
  try {
    const staged = await stageAtomicMediaPlans(preview, downloads);
    atomicPlans = staged.plans;
    const mediaByExternalId = new Map(atomicPlans.map((plan) => [plan.externalId, plan]));
    result = applyContentPlanV3(preview, {
      actorSource: 'google_sheets',
      sourceTypeOverride: 'google_sheets',
      newPostIds: staged.newPostIds,
      afterRow: ({ row, postId, classification }) => {
        if (!['NEW', 'UPDATE'].includes(classification)) return;
        const plan = mediaByExternalId.get(row.externalId);
        if (!plan) return;
        if (plan.postId !== postId) throw new Error(`Cloud media post identity changed during apply: ${row.externalId}`);
        applyAtomicMediaPlan(plan);
      }
    });
    syncedRows = atomicPlans.length;
    committed = true;
  } catch (error) {
    await cleanupStagedFiles(atomicPlans);
    event({ level: 'error', type: 'cloud_media.apply_failed', message: error instanceof Error ? error.message : String(error), data: { connectorId } });
    throw error;
  } finally {
    await Promise.all(downloads.flatMap((plan) => plan.files.map((file) => file.cleanup()))).catch(() => undefined);
  }
  if (committed) await cleanupPreviousFiles(atomicPlans, connectorId);

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
