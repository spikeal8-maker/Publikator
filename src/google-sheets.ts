import crypto from 'node:crypto';
import { db, event, nowIso } from './db.js';
import {
  CONTENT_PLAN_V3_COLUMNS,
  applyContentPlanV3,
  parseContentPlanV3,
  validateContentPlanV3,
  type V3Classification,
  type V3Validation
} from './content-plan-v3.js';
import {
  createIngestionConnector,
  readIngestionConnectorCredentials,
  type ConnectorMetadata
} from './integration-security.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';
const READ_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SOURCE_TYPE = 'google_sheets';
const MAX_SHEET_ROWS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MINUTES = new Set([5, 15, 30, 60]);

type ServiceAccountCredentials = {
  type: 'service_account';
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export type GoogleSheetsConfig = {
  spreadsheetId: string;
  sheetName: string;
  writeBack: boolean;
  serviceAccountEmail: string;
  pollingEnabled: boolean;
  pollIntervalMinutes: number;
  autoApplyEnabled: boolean;
  autoReadyEnabled: boolean;
};

type ConnectorRow = {
  id: string;
  type: string;
  name: string;
  config_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type GoogleSheetsConnector = ConnectorMetadata & { config: GoogleSheetsConfig };
export type GoogleSheetInspection = { spreadsheetTitle: string; sheets: string[]; serviceAccountEmail: string };
export type GoogleSheetsPreview = V3Validation & {
  connectorId: string;
  spreadsheetId: string;
  sheetName: string;
  sourceSnapshotSha256: string;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function normalizeCredentials(value: unknown): ServiceAccountCredentials {
  const row = asRecord(value, 'Service account JSON');
  if (row.type !== 'service_account') throw new Error('Google credential type must be service_account');
  const clientEmail = String(row.client_email ?? '').trim();
  const privateKey = String(row.private_key ?? '').trim();
  const tokenUri = String(row.token_uri ?? GOOGLE_TOKEN_URL).trim();
  if (!/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/i.test(clientEmail)) throw new Error('Service account client_email is invalid');
  if (!privateKey.includes('BEGIN PRIVATE KEY') || privateKey.length > 32 * 1024) throw new Error('Service account private_key is invalid');
  if (tokenUri !== GOOGLE_TOKEN_URL) throw new Error('Only the standard Google OAuth token endpoint is allowed');
  return { type: 'service_account', client_email: clientEmail, private_key: privateKey, token_uri: GOOGLE_TOKEN_URL };
}

function normalizeSpreadsheetId(value: unknown): string {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new Error('spreadsheetId is invalid');
  return id;
}

function normalizeSheetName(value: unknown): string {
  const name = String(value ?? '').trim();
  if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name)) throw new Error('sheetName is invalid');
  return name;
}

function normalizePollInterval(value: unknown): number {
  const interval = Number(value ?? 15);
  if (!Number.isInteger(interval) || !POLL_INTERVAL_MINUTES.has(interval)) throw new Error('pollIntervalMinutes must be 5, 15, 30 or 60');
  return interval;
}

function normalizeConfig(value: unknown, serviceAccountEmail?: string): GoogleSheetsConfig {
  const row = asRecord(value, 'Google Sheets config');
  return {
    spreadsheetId: normalizeSpreadsheetId(row.spreadsheetId),
    sheetName: normalizeSheetName(row.sheetName),
    writeBack: row.writeBack === true,
    serviceAccountEmail: serviceAccountEmail ?? String(row.serviceAccountEmail ?? '').trim(),
    pollingEnabled: row.pollingEnabled === true,
    pollIntervalMinutes: normalizePollInterval(row.pollIntervalMinutes),
    autoApplyEnabled: row.autoApplyEnabled === true,
    autoReadyEnabled: row.autoReadyEnabled === true
  };
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Google API request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function accessToken(credentialsRaw: unknown, scope: string): Promise<string> {
  const credentials = normalizeCredentials(credentialsRaw);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope,
    aud: GOOGLE_TOKEN_URL,
    iat: now - 30,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  let signature: string;
  try {
    signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
  } catch {
    throw new Error('Service account private_key could not sign an OAuth assertion');
  }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsigned}.${signature}`
  });
  const response = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== 'string') {
    throw new Error(`Google OAuth failed (HTTP ${response.status})`);
  }
  return payload.access_token;
}

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, accept: 'application/json' };
}

function quoteSheetName(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function inspectSpreadsheetRaw(credentials: unknown, spreadsheetIdRaw: unknown): Promise<GoogleSheetInspection> {
  const spreadsheetId = normalizeSpreadsheetId(spreadsheetIdRaw);
  const normalized = normalizeCredentials(credentials);
  const token = await accessToken(normalized, READ_SCOPE);
  const url = `${GOOGLE_SHEETS_ROOT}/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties(sheetId,title)`;
  const response = await fetchWithTimeout(url, { headers: authHeaders(token) });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(`Google Sheets metadata request failed (HTTP ${response.status})`);
  const sheets = Array.isArray(payload.sheets)
    ? payload.sheets.map((item: any) => String(item?.properties?.title ?? '').trim()).filter(Boolean)
    : [];
  if (!sheets.length) throw new Error('Google spreadsheet contains no sheets');
  return {
    spreadsheetTitle: String(payload?.properties?.title ?? spreadsheetId),
    sheets,
    serviceAccountEmail: normalized.client_email
  };
}

export async function inspectGoogleSpreadsheet(credentials: unknown, spreadsheetId: unknown): Promise<GoogleSheetInspection> {
  return inspectSpreadsheetRaw(credentials, spreadsheetId);
}

function connectorRow(connectorId: string, requireEnabled = true): ConnectorRow {
  const row = db.prepare(`SELECT id,type,name,config_json,enabled,created_at,updated_at FROM ingestion_connectors
    WHERE id=? AND type='google_sheets'`).get(connectorId) as ConnectorRow | undefined;
  if (!row || (requireEnabled && !row.enabled)) throw new Error('Enabled Google Sheets connector not found');
  return row;
}

function connectorMetadata(row: ConnectorRow): GoogleSheetsConnector {
  const config = normalizeConfig(JSON.parse(row.config_json));
  return {
    id: row.id,
    type: 'google_sheets',
    name: row.name,
    config,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listGoogleSheetsConnectors(): GoogleSheetsConnector[] {
  return (db.prepare(`SELECT id,type,name,config_json,enabled,created_at,updated_at FROM ingestion_connectors
    WHERE type='google_sheets' ORDER BY created_at,id`).all() as ConnectorRow[]).map(connectorMetadata);
}

export async function createGoogleSheetsConnector(params: {
  name: string;
  spreadsheetId: unknown;
  sheetName: unknown;
  writeBack?: boolean;
  pollingEnabled?: boolean;
  pollIntervalMinutes?: unknown;
  autoApplyEnabled?: boolean;
  autoReadyEnabled?: boolean;
  credentials: unknown;
}): Promise<GoogleSheetsConnector> {
  const credentials = normalizeCredentials(params.credentials);
  const inspection = await inspectSpreadsheetRaw(credentials, params.spreadsheetId);
  const sheetName = normalizeSheetName(params.sheetName);
  if (!inspection.sheets.includes(sheetName)) throw new Error(`Sheet not found: ${sheetName}`);
  const config = normalizeConfig({
    spreadsheetId: params.spreadsheetId,
    sheetName,
    writeBack: params.writeBack === true,
    pollingEnabled: params.pollingEnabled === true,
    pollIntervalMinutes: params.pollIntervalMinutes ?? 15,
    autoApplyEnabled: params.autoApplyEnabled === true,
    autoReadyEnabled: params.autoReadyEnabled === true
  }, credentials.client_email);
  if (config.autoReadyEnabled && !config.autoApplyEnabled) throw new Error('autoReadyEnabled requires autoApplyEnabled');
  const created = createIngestionConnector({
    type: 'google_sheets',
    name: params.name,
    config,
    credentials
  });
  return { ...created, config };
}

export function updateGoogleSheetsPolling(connectorId: string, params: { enabled: boolean; intervalMinutes: unknown; autoApplyEnabled?: boolean; autoReadyEnabled?: boolean }): GoogleSheetsConnector {
  const row = connectorRow(connectorId, false);
  const current = normalizeConfig(JSON.parse(row.config_json));
  const autoApplyEnabled = typeof params.autoApplyEnabled === 'boolean' ? params.autoApplyEnabled : current.autoApplyEnabled;
  let autoReadyEnabled = typeof params.autoReadyEnabled === 'boolean' ? params.autoReadyEnabled : current.autoReadyEnabled;
  if (!autoApplyEnabled) autoReadyEnabled = false;
  if (params.autoReadyEnabled === true && !autoApplyEnabled) throw new Error('autoReadyEnabled requires autoApplyEnabled');
  const config = { ...current, pollingEnabled: params.enabled, pollIntervalMinutes: normalizePollInterval(params.intervalMinutes), autoApplyEnabled, autoReadyEnabled };
  db.prepare('UPDATE ingestion_connectors SET config_json=?,updated_at=? WHERE id=?').run(JSON.stringify(config), nowIso(), connectorId);
  return connectorMetadata(connectorRow(connectorId, false));
}

export async function testGoogleSheetsConnector(connectorId: string): Promise<GoogleSheetInspection & { sheetName: string; writeBack: boolean }> {
  const row = connectorRow(connectorId);
  const config = normalizeConfig(JSON.parse(row.config_json));
  const credentials = readIngestionConnectorCredentials(connectorId);
  const inspection = await inspectSpreadsheetRaw(credentials, config.spreadsheetId);
  if (!inspection.sheets.includes(config.sheetName)) throw new Error(`Configured sheet not found: ${config.sheetName}`);
  return { ...inspection, sheetName: config.sheetName, writeBack: config.writeBack };
}

async function sheetValues(connectorId: string): Promise<{ config: GoogleSheetsConfig; credentials: Record<string, unknown>; values: unknown[][] }> {
  const row = connectorRow(connectorId);
  const config = normalizeConfig(JSON.parse(row.config_json));
  const credentials = readIngestionConnectorCredentials(connectorId);
  const token = await accessToken(credentials, READ_SCOPE);
  const range = `${quoteSheetName(config.sheetName)}!A1:U${MAX_SHEET_ROWS + 1}`;
  const url = `${GOOGLE_SHEETS_ROOT}/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  const response = await fetchWithTimeout(url, { headers: authHeaders(token) });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(`Google Sheets values request failed (HTTP ${response.status})`);
  const values = Array.isArray(payload.values) ? payload.values as unknown[][] : [];
  if (values.length > MAX_SHEET_ROWS + 1) throw new Error(`Google Sheet has more than ${MAX_SHEET_ROWS} data rows`);
  return { config, credentials, values };
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function valuesToCsv(values: unknown[][]): Buffer {
  const rows = values.map((row) => row.slice(0, CONTENT_PLAN_V3_COLUMNS.length).map(csvCell).join(','));
  return Buffer.from(`${rows.join('\n')}\n`, 'utf8');
}

function sourceId(connectorId: string): string {
  return `gs:${connectorId}`;
}

function sourceRef(connectorId: string, externalId: string): string {
  return JSON.stringify([sourceId(connectorId), externalId]);
}

function sourceAction(values: unknown[][]): void {
  for (let index = 1; index < values.length; index += 1) {
    const row = values[index] ?? [];
    if (row.every((item) => String(item ?? '').trim() === '')) continue;
    const action = String(row[2] ?? '').trim().toUpperCase();
    if (action !== 'UPSERT') throw new Error('Google Sheets sync currently accepts action=UPSERT only; row deletion never deletes a Publikator post');
  }
}

function reclassifyForGoogleSheets(validation: V3Validation, connectorId: string): V3Validation {
  const rows = validation.rows.map((input) => {
    if (!input.normalized) return input;
    const row: any = { ...input.normalized };
    const existing = db.prepare(`SELECT id,content_version,imported_content_version,source_revision,source_payload_hash,status
      FROM posts WHERE source_type='google_sheets' AND source_ref=?`).get(sourceRef(connectorId, row.externalId)) as any;
    if (!existing) {
      row.classification = 'NEW';
      row.postId = null;
      row.importedContentVersion = null;
      return { ...input, classification: 'NEW' as V3Classification, normalized: row };
    }
    row.postId = existing.id;
    row.importedContentVersion = existing.imported_content_version;
    if (existing.source_payload_hash === row.payloadHash) {
      row.classification = 'UNCHANGED';
      return { ...input, classification: 'UNCHANGED' as V3Classification, normalized: row };
    }
    if (existing.source_revision === row.sourceRevision) {
      return { ...input, classification: 'ERROR' as V3Classification, errors: ['source_revision was reused with a different payload'], normalized: null };
    }
    if (!['DRAFT', 'READY', 'FAILED'].includes(existing.status)) {
      return { ...input, classification: 'ERROR' as V3Classification, errors: [`Post status=${existing.status} is immutable for Google Sheets sync`], normalized: null };
    }
    if (existing.imported_content_version == null || existing.content_version !== existing.imported_content_version) {
      row.classification = 'CONFLICT';
      return { ...input, classification: 'CONFLICT' as V3Classification, normalized: row };
    }
    row.classification = 'UPDATE';
    return { ...input, classification: 'UPDATE' as V3Classification, normalized: row };
  });
  const count = (kind: V3Classification) => rows.filter((row) => row.classification === kind).length;
  const conflicts = count('CONFLICT');
  const errors = count('ERROR');
  return {
    ...validation,
    canApply: conflicts === 0 && errors === 0,
    summary: {
      totalRows: rows.length,
      newRows: count('NEW'),
      updateRows: count('UPDATE'),
      unchangedRows: count('UNCHANGED'),
      conflicts,
      requests: 0,
      errors
    },
    rows
  };
}

async function previewFromValues(connectorId: string, values: unknown[][]): Promise<V3Validation> {
  sourceAction(values);
  const parsed = await parseContentPlanV3('google-sheet.csv', valuesToCsv(values));
  const base = await validateContentPlanV3(parsed, sourceId(connectorId));
  return reclassifyForGoogleSheets(base, connectorId);
}

export async function previewGoogleSheetsValues(connectorId: string, values: unknown[][]): Promise<GoogleSheetsPreview> {
  const row = connectorRow(connectorId);
  const config = normalizeConfig(JSON.parse(row.config_json));
  const validation = await previewFromValues(connectorId, values);
  return {
    ...validation,
    connectorId,
    spreadsheetId: config.spreadsheetId,
    sheetName: config.sheetName,
    sourceSnapshotSha256: validation.fileSha256
  };
}

export async function previewGoogleSheetsConnector(connectorId: string): Promise<GoogleSheetsPreview> {
  const { values } = await sheetValues(connectorId);
  return previewGoogleSheetsValues(connectorId, values);
}

function forceNewRowsToGoogleSource(validation: V3Validation, connectorId: string, resultPostIds: string[]): void {
  const createdExternalIds = validation.rows
    .filter((row) => row.classification === 'NEW' && row.normalized)
    .map((row) => (row.normalized as any).externalId as string);
  if (!createdExternalIds.length) return;
  const createdRefs = new Set(createdExternalIds.map((externalId) => sourceRef(connectorId, externalId)));
  for (const postId of resultPostIds) {
    const row = db.prepare('SELECT source_ref,source_type FROM posts WHERE id=?').get(postId) as { source_ref: string | null; source_type: string | null } | undefined;
    if (row?.source_type === 'content-plan-v3' && row.source_ref && createdRefs.has(row.source_ref)) {
      db.prepare("UPDATE posts SET source_type='google_sheets' WHERE id=?").run(postId);
    }
  }
}

async function writeBack(connectorId: string, config: GoogleSheetsConfig, credentials: Record<string, unknown>, validation: V3Validation): Promise<void> {
  if (!config.writeBack) return;
  const token = await accessToken(credentials, WRITE_SCOPE);
  const source = sourceId(connectorId);
  const data: Array<{ range: string; majorDimension: 'ROWS'; values: string[][] }> = [{
    range: `${quoteSheetName(config.sheetName)}!V1:Y1`,
    majorDimension: 'ROWS',
    values: [['publikator_id', 'import_status', 'imported_at', 'last_error']]
  }];
  const importedAt = nowIso();
  for (const item of validation.rows) {
    const normalized: any = item.normalized;
    if (!normalized) continue;
    const ref = JSON.stringify([source, normalized.externalId]);
    const post = db.prepare("SELECT id FROM posts WHERE source_type='google_sheets' AND source_ref=?").get(ref) as { id: string } | undefined;
    data.push({
      range: `${quoteSheetName(config.sheetName)}!V${item.rowNumber}:Y${item.rowNumber}`,
      majorDimension: 'ROWS',
      values: [[post?.id ?? '', item.classification, importedAt, '']]
    });
  }
  const url = `${GOOGLE_SHEETS_ROOT}/${encodeURIComponent(config.spreadsheetId)}/values:batchUpdate`;
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data })
  });
  if (!response.ok) throw new Error(`Google Sheets status write-back failed (HTTP ${response.status})`);
}

export async function applyGoogleSheetsValues(connectorId: string, expectedSnapshotSha256: string, values: unknown[][]): Promise<{
  created: number; updated: number; unchanged: number; archived: number; trashed: number; postIds: string[];
  sourceSnapshotSha256: string;
  writeBack: { attempted: boolean; ok: boolean; error: string | null };
}> {
  if (!/^[a-f0-9]{64}$/i.test(expectedSnapshotSha256)) throw new Error('A preview SHA-256 is required');
  const row = connectorRow(connectorId);
  const config = normalizeConfig(JSON.parse(row.config_json));
  const credentials = readIngestionConnectorCredentials(connectorId);
  const validation = await previewFromValues(connectorId, values);
  if (validation.fileSha256 !== expectedSnapshotSha256.toLowerCase()) throw new Error('Google Sheet changed after preview; preview again before apply');
  if (!validation.canApply) throw new Error('Google Sheets preview contains ERROR/CONFLICT');
  const result = db.transaction(() => {
    const applied = applyContentPlanV3(validation);
    forceNewRowsToGoogleSource(validation, connectorId, applied.postIds);
    return applied;
  })();
  event({
    type: 'google_sheets.applied',
    message: `Google Sheets sync applied: ${validation.rows.length} rows`,
    data: { connectorId, spreadsheetId: config.spreadsheetId, sheetName: config.sheetName, ...result }
  });
  const writeBackResult = { attempted: config.writeBack, ok: true, error: null as string | null };
  if (config.writeBack) {
    try { await writeBack(connectorId, config, credentials, validation); }
    catch (error) {
      writeBackResult.ok = false;
      writeBackResult.error = error instanceof Error ? error.message : String(error);
      event({ level: 'warning', type: 'google_sheets.writeback_failed', message: writeBackResult.error, data: { connectorId } });
    }
  }
  return { ...result, sourceSnapshotSha256: validation.fileSha256, writeBack: writeBackResult };
}

export async function applyGoogleSheetsConnector(connectorId: string, expectedSnapshotSha256: string) {
  const { values } = await sheetValues(connectorId);
  return applyGoogleSheetsValues(connectorId, expectedSnapshotSha256, values);
}
