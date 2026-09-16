import { db, event } from './db.js';
import { beginMaintenance, maintenanceState } from './runtime-gate.js';
import { listGoogleSheetsConnectors, type GoogleSheetsConnector } from './google-sheets.js';
import { applyGoogleSheetsCloudMedia, previewGoogleSheetsCloudMedia } from './google-sheets-cloud-media.js';
import { autoReadyGoogleSheetsPost } from './google-sheets-auto-ready.js';

const POLL_OK = 'google_sheets.poll_preview_succeeded';
const POLL_FAILED = 'google_sheets.poll_preview_failed';

type PollEventData = {
  connectorId?: string;
  intervalMinutes?: number;
  summary?: Record<string, number>;
  canApply?: boolean;
  sourceSnapshotSha256?: string;
  mediaSnapshotSha256?: string | null;
  error?: string;
  stage?: 'preview' | 'apply' | 'ready';
  autoApply?: { attempted: boolean; ok: boolean | null; created: number; updated: number; unchanged: number; error: string | null };
  autoReady?: { attempted: boolean; ready: number; blocked: number; skipped: number };
};

type PollEventRow = {
  event_type: string;
  level: string;
  message: string;
  data_json: string | null;
  created_at: string;
};
export type GoogleSheetsPollingStatus = {
  enabled: boolean;
  intervalMinutes: number;
  lastAttemptAt: string | null;
  lastResult: 'success' | 'failed' | null;
  lastError: string | null;
  lastSummary: Record<string, number> | null;
  lastCanApply: boolean | null;
  nextDueAt: string | null;
  lastAutoApply: PollEventData['autoApply'] | null;
  lastAutoReady: PollEventData['autoReady'] | null;
};

function eventData(row: PollEventRow | undefined): PollEventData {
  if (!row?.data_json) return {};
  try {
    const parsed = JSON.parse(row.data_json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PollEventData : {};
  } catch {
    return {};
  }
}

function latestPollEvent(connectorId: string): PollEventRow | undefined {
  return db.prepare(`SELECT event_type,level,message,data_json,created_at FROM publication_events
    WHERE event_type IN (?,?) AND data_json LIKE ? ORDER BY created_at DESC LIMIT 1`)
    .get(POLL_OK, POLL_FAILED, `%\"connectorId\":\"${connectorId}\"%`) as PollEventRow | undefined;
}
export function googleSheetsPollingStatus(connector: GoogleSheetsConnector): GoogleSheetsPollingStatus {
  const last = latestPollEvent(connector.id);
  const data = eventData(last);
  const enabled = connector.enabled && connector.config.pollingEnabled;
  let nextDueAt: string | null = null;
  if (enabled) {
    const base = last ? new Date(last.created_at).getTime() : Date.now();
    nextDueAt = new Date(base + connector.config.pollIntervalMinutes * 60_000).toISOString();
    if (!last) nextDueAt = null;
  }
  return {
    enabled,
    intervalMinutes: connector.config.pollIntervalMinutes,
    lastAttemptAt: last?.created_at ?? null,
    lastResult: last ? (last.event_type === POLL_OK ? 'success' : 'failed') : null,
    lastError: last?.event_type === POLL_FAILED ? (data.error || last.message) : null,
    lastSummary: data.summary ?? null,
    lastCanApply: typeof data.canApply === 'boolean' ? data.canApply : null,
    nextDueAt,
    lastAutoApply: data.autoApply ?? null,
    lastAutoReady: data.autoReady ?? null
  };
}

function isDue(connector: GoogleSheetsConnector, at: Date): boolean {
  if (!connector.enabled || !connector.config.pollingEnabled) return false;
  const last = latestPollEvent(connector.id);
  if (!last) return true;
  return at.getTime() >= new Date(last.created_at).getTime() + connector.config.pollIntervalMinutes * 60_000;
}
let pollRunning = false;

export async function googleSheetsPollingTick(at: Date = new Date()): Promise<{
  skipped: boolean;
  checked: number;
  due: number;
  previews: number;
  warnings: number;
  errors: number;
  autoAppliedRuns: number;
  autoReadyPosts: number;
}> {
  if (pollRunning || maintenanceState().active) return { skipped: true, checked: 0, due: 0, previews: 0, warnings: 0, errors: 0, autoAppliedRuns: 0, autoReadyPosts: 0 };
  pollRunning = true;
  const report = { skipped: false, checked: 0, due: 0, previews: 0, warnings: 0, errors: 0, autoAppliedRuns: 0, autoReadyPosts: 0 };
  try {
    const connectors = listGoogleSheetsConnectors().filter((connector) => connector.enabled && connector.config.pollingEnabled);
    report.checked = connectors.length;
    for (const connector of connectors) {
      if (maintenanceState().active) break;
      if (!isDue(connector, at)) continue;
      report.due += 1;
      let summary: Record<string, number> | undefined;
      let canApply: boolean | undefined;
      let sourceSnapshotSha256: string | undefined;
      let mediaSnapshotSha256: string | null = null;
      let stage: 'preview' | 'apply' | 'ready' = 'preview';
      let autoApply = { attempted: false, ok: null as boolean | null, created: 0, updated: 0, unchanged: 0, error: null as string | null };
      let autoReady = { attempted: false, ready: 0, blocked: 0, skipped: 0 };
      try {
        const preview = await previewGoogleSheetsCloudMedia(connector.id);
        report.previews += 1;
        summary = preview.summary as unknown as Record<string, number>;
        canApply = preview.canApply;
        sourceSnapshotSha256 = preview.sourceSnapshotSha256;
        mediaSnapshotSha256 = 'mediaSnapshotSha256' in preview ? preview.mediaSnapshotSha256 : null;
        const blocked = Number(summary.conflicts || 0) > 0 || Number(summary.errors || 0) > 0;
        if (blocked) report.warnings += 1;
        const changes = Number(summary.newRows || 0) + Number(summary.updateRows || 0);

        if (!blocked && preview.canApply && connector.config.autoApplyEnabled && changes > 0) {
          stage = 'apply';
          autoApply.attempted = true;
          let release: (() => void) | null = null;
          try {
            release = beginMaintenance(`google-sheets auto apply: ${connector.name}`);
            const applied = await applyGoogleSheetsCloudMedia(connector.id, preview.sourceSnapshotSha256, mediaSnapshotSha256);
            autoApply = {
              attempted: true,
              ok: true,
              created: Number(applied.created || 0),
              updated: Number(applied.updated || 0),
              unchanged: Number(applied.unchanged || 0),
              error: null
            };
            report.autoAppliedRuns += 1;

            if (connector.config.autoReadyEnabled) {
              stage = 'ready';
              autoReady.attempted = true;
              for (const postId of applied.postIds) {
                const ready = autoReadyGoogleSheetsPost(postId);
                if (ready.outcome === 'ready') {
                  autoReady.ready += 1;
                  report.autoReadyPosts += 1;
                } else if (ready.outcome === 'blocked') autoReady.blocked += 1;
                else autoReady.skipped += 1;
              }
              if (autoReady.blocked > 0) report.warnings += 1;
            }
          } finally {
            release?.();
          }
        }

        const attention = blocked || autoReady.blocked > 0;
        event({
          level: attention ? 'warning' : 'info',
          type: POLL_OK,
          message: blocked
            ? `Google Sheets preview requires attention: ${connector.name}`
            : autoReady.attempted && autoReady.blocked > 0
              ? `Google Sheets changes imported; Auto Ready blocked for ${autoReady.blocked} post(s): ${connector.name}`
              : autoReady.ready > 0
                ? `Google Sheets changes imported and ${autoReady.ready} post(s) passed Auto Ready: ${connector.name}`
                : autoApply.ok === true
                  ? `Google Sheets safe changes auto-applied: ${connector.name}`
                  : `Google Sheets preview completed: ${connector.name}`,
          data: {
            connectorId: connector.id,
            intervalMinutes: connector.config.pollIntervalMinutes,
            summary,
            canApply: preview.canApply,
            sourceSnapshotSha256: preview.sourceSnapshotSha256,
            mediaSnapshotSha256,
            stage,
            autoApply,
            autoReady
          }
        });
      } catch (error) {
        report.errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (autoApply.attempted) autoApply = { ...autoApply, ok: false, error: message };
        event({
          level: 'error',
          type: POLL_FAILED,
          message: `Google Sheets ${stage === 'apply' ? 'auto-apply' : stage === 'ready' ? 'auto-ready' : 'preview poll'} failed: ${connector.name}: ${message}`,
          data: {
            connectorId: connector.id,
            intervalMinutes: connector.config.pollIntervalMinutes,
            summary,
            canApply,
            sourceSnapshotSha256,
            mediaSnapshotSha256,
            error: message,
            stage,
            autoApply,
            autoReady
          }
        });
      }
    }
    return report;
  } finally {
    pollRunning = false;
  }
}
