import crypto from 'node:crypto';
import { db, event } from './db.js';
import { readIngestionConnectorCredentials } from './integration-security.js';
import { spreadsheetSafeText } from './ingestion-security.js';
import { googleBearerHeaders, googleFetchWithTimeout, googleServiceAccountAccessToken } from './google-service-account.js';
import { maintenanceState } from './runtime-gate.js';

const GOOGLE_SHEETS_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const MAX_SHEET_ROWS = 10_000;
const MAX_POSTS_PER_TICK = 100;
const EVENT_OK = 'google_sheets.publication_writeback_succeeded';
const EVENT_FAILED = 'google_sheets.publication_writeback_failed';

type Connector = {
  id: string;
  name: string;
  config: { spreadsheetId: string; sheetName: string; writeBack: boolean };
};

type SourcePost = {
  id: string;
  status: string;
  editorial_stage: string;
  source_ref: string;
};
type TargetResult = {
  platform: string;
  account_name: string;
  state: string;
  external_id: string | null;
  external_url: string | null;
  published_at: string | null;
  last_error: string | null;
};

type PublicationPayload = {
  status: string;
  editorialStage: string;
  publishedAt: string;
  externalUrls: string;
  error: string;
};

type PendingWrite = {
  postId: string;
  connectorId: string;
  externalId: string;
  payload: PublicationPayload;
  payloadHash: string;
};

function quoteSheetName(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseSourceRef(sourceRef: string): { connectorId: string; externalId: string } | null {
  try {
    const parsed = JSON.parse(sourceRef);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const sourceId = String(parsed[0] ?? '');
    const externalId = String(parsed[1] ?? '').trim();
    if (!sourceId.startsWith('gs:') || !externalId) return null;
    const connectorId = sourceId.slice(3);
    return connectorId ? { connectorId, externalId } : null;
  } catch {
    return null;
  }
}

function connector(connectorId: string): Connector | null {
  const row = db.prepare(`SELECT id,name,config_json,enabled FROM ingestion_connectors
    WHERE id=? AND type='google_sheets'`).get(connectorId) as { id: string; name: string; config_json: string; enabled: number } | undefined;
  if (!row?.enabled) return null;
  const config = JSON.parse(row.config_json) as Record<string, unknown>;
  if (config.writeBack !== true) return null;
  return { id: row.id, name: row.name, config: {
    spreadsheetId: String(config.spreadsheetId ?? ''), sheetName: String(config.sheetName ?? ''), writeBack: true
  } };
}
function publicationPayload(post: SourcePost): PublicationPayload {
  const targets = db.prepare(`SELECT pt.state,pt.external_id,pt.external_url,pt.published_at,pt.last_error,
      a.platform,a.name AS account_name
    FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id
    WHERE pt.post_id=? AND pt.enabled=1 ORDER BY a.platform,a.name`)
    .all(post.id) as TargetResult[];
  const publishedAt = targets.map((item) => item.published_at).filter((value): value is string => Boolean(value)).sort().at(-1) ?? '';
  const external = targets
    .filter((item) => item.external_url || item.external_id)
    .map((item) => ({
      platform: item.platform,
      account: item.account_name,
      externalId: item.external_id,
      url: item.external_url,
      state: item.state
    }));
  const errors = targets
    .filter((item) => item.last_error)
    .map((item) => `${item.platform}/${item.account_name}: ${item.last_error}`);
  return {
    status: post.status,
    editorialStage: post.editorial_stage,
    publishedAt,
    externalUrls: external.length ? JSON.stringify(external) : '',
    error: errors.join(' | ').slice(0, 12_000)
  };
}
function latestSuccessHash(postId: string): string | null {
  const row = db.prepare(`SELECT data_json FROM publication_events
    WHERE post_id=? AND event_type=? ORDER BY created_at DESC LIMIT 1`)
    .get(postId, EVENT_OK) as { data_json: string | null } | undefined;
  if (!row?.data_json) return null;
  try {
    const parsed = JSON.parse(row.data_json) as Record<string, unknown>;
    return typeof parsed.payloadHash === 'string' ? parsed.payloadHash : null;
  } catch {
    return null;
  }
}

function pendingWrites(connectorFilter?: string): PendingWrite[] {
  const posts = db.prepare(`SELECT id,status,editorial_stage,source_ref FROM posts
    WHERE source_type='google_sheets' AND source_ref IS NOT NULL
    ORDER BY updated_at DESC,id`).all() as SourcePost[];
  const pending: PendingWrite[] = [];
  for (const post of posts) {
    const source = parseSourceRef(post.source_ref);
    if (!source || (connectorFilter && source.connectorId !== connectorFilter) || !connector(source.connectorId)) continue;
    const payload = publicationPayload(post);
    const payloadHash = sha256(JSON.stringify(payload));
    if (latestSuccessHash(post.id) === payloadHash) continue;
    pending.push({ postId: post.id, connectorId: source.connectorId, externalId: source.externalId, payload, payloadHash });
    if (pending.length >= MAX_POSTS_PER_TICK) break;
  }
  return pending;
}
async function externalIdRows(conn: Connector, token: string): Promise<Map<string, number[]>> {
  const range = `${quoteSheetName(conn.config.sheetName)}!B2:B${MAX_SHEET_ROWS + 1}`;
  const url = `${GOOGLE_SHEETS_ROOT}/${encodeURIComponent(conn.config.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const response = await googleFetchWithTimeout(url, { headers: googleBearerHeaders(token) });
  const payload = await response.json().catch(() => ({})) as { values?: unknown[][] };
  if (!response.ok) throw new Error(`Google Sheets external_id lookup failed (HTTP ${response.status})`);
  const rows = new Map<string, number[]>();
  const values = Array.isArray(payload.values) ? payload.values : [];
  values.forEach((row, index) => {
    const externalId = String(row?.[0] ?? '').trim();
    if (!externalId) return;
    const found = rows.get(externalId) ?? [];
    found.push(index + 2);
    rows.set(externalId, found);
  });
  return rows;
}

function safe(value: string): string {
  return spreadsheetSafeText(value);
}

function resultValues(payload: PublicationPayload): string[] {
  return [payload.status, payload.editorialStage, payload.publishedAt, payload.externalUrls, payload.error].map(safe);
}
function writeSucceeded(item: PendingWrite, rowNumber: number): void {
  event({
    postId: item.postId,
    type: EVENT_OK,
    message: 'Publication result written back to Google Sheets',
    data: { connectorId: item.connectorId, externalId: item.externalId, rowNumber, payloadHash: item.payloadHash }
  });
}

function writeFailed(item: PendingWrite, message: string): void {
  event({
    postId: item.postId,
    level: 'warning',
    type: EVENT_FAILED,
    message,
    data: { connectorId: item.connectorId, externalId: item.externalId, payloadHash: item.payloadHash }
  });
}

async function flushConnector(conn: Connector, items: PendingWrite[]): Promise<{ written: number; failed: number }> {
  const credentials = readIngestionConnectorCredentials(conn.id);
  const token = await googleServiceAccountAccessToken(credentials, WRITE_SCOPE);
  const rows = await externalIdRows(conn, token);
  const data: Array<{ range: string; majorDimension: 'ROWS'; values: string[][] }> = [{
    range: `${quoteSheetName(conn.config.sheetName)}!Z1:AD1`, majorDimension: 'ROWS',
    values: [['publication_status', 'editorial_stage', 'published_at', 'external_urls', 'publication_error']]
  }];
  const prepared: Array<{ item: PendingWrite; rowNumber: number }> = [];
  for (const item of items) {
    const matches = rows.get(item.externalId) ?? [];
    if (matches.length !== 1) {
      writeFailed(item, matches.length === 0
        ? `Google Sheets publication write-back: external_id not found: ${item.externalId}`
        : `Google Sheets publication write-back: external_id is ambiguous: ${item.externalId}`);
      continue;
    }
    const rowNumber = matches[0]!;
    data.push({
      range: `${quoteSheetName(conn.config.sheetName)}!Z${rowNumber}:AD${rowNumber}`,
      majorDimension: 'ROWS',
      values: [resultValues(item.payload)]
    });
    prepared.push({ item, rowNumber });
  }
  if (!prepared.length) return { written: 0, failed: items.length };

  const response = await googleFetchWithTimeout(`${GOOGLE_SHEETS_ROOT}/${encodeURIComponent(conn.config.spreadsheetId)}/values:batchUpdate`, {
    method: 'POST',
    headers: { ...googleBearerHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data })
  });
  if (!response.ok) throw new Error(`Google Sheets publication write-back failed (HTTP ${response.status})`);
  for (const entry of prepared) writeSucceeded(entry.item, entry.rowNumber);
  return { written: prepared.length, failed: items.length - prepared.length };
}
let running = false;

export async function googleSheetsPublicationWriteBackTick(connectorFilter?: string): Promise<{
  skipped: boolean;
  pending: number;
  written: number;
  failed: number;
}> {
  if (running || maintenanceState().active) return { skipped: true, pending: 0, written: 0, failed: 0 };
  running = true;
  try {
    if (connectorFilter && !connector(connectorFilter)) throw new Error('Enabled Google Sheets connector with write-back not found');
    const pending = pendingWrites(connectorFilter);
    let written = 0;
    let failed = 0;
    const grouped = new Map<string, PendingWrite[]>();
    for (const item of pending) grouped.set(item.connectorId, [...(grouped.get(item.connectorId) ?? []), item]);
    for (const [connectorId, items] of grouped) {
      const conn = connector(connectorId);
      if (!conn) continue;
      try {
        const result = await flushConnector(conn, items);
        written += result.written;
        failed += result.failed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const item of items) writeFailed(item, message);
        failed += items.length;
      }
    }
    return { skipped: false, pending: pending.length, written, failed };
  } finally {
    running = false;
  }
}
