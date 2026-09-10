import { config } from './config.js';
import { db, event, id, nowIso, type Platform } from './db.js';
import { collectDiagnostics } from './diagnostics.js';
import { listBackupBundles } from './backups.js';

export const RELEASE_PLATFORMS: Platform[] = ['telegram', 'vk', 'max', 'instagram'];
export type ReleaseAcceptanceStatus = 'NOT_TESTED' | 'PASS' | 'FAIL';

export type ReleaseAcceptanceView = {
  platform: Platform;
  targetVersion: string;
  status: ReleaseAcceptanceStatus;
  commitSha: string | null;
  accountName: string | null;
  testedAt: string | null;
  notes: string | null;
};

export type ReleaseGateSnapshot = {
  targetVersion: string;
  appBuildSha: string | null;
  acceptanceCommitSha: string | null;
  generatedAt: string;
  releaseReady: boolean;
  requiresAutomatedCi: true;
  acceptance: ReleaseAcceptanceView[];
  latestBackup: { name: string; createdAt: string } | null;
  latestAcceptanceAt: string | null;
  backupAfterAcceptance: boolean;
  diagnosticsSeverity: 'ok' | 'warning' | 'error';
  blockers: string[];
  warnings: string[];
};

type AcceptanceRow = {
  platform: Platform;
  target_version: string;
  status: 'PASS' | 'FAIL';
  commit_sha: string;
  account_name: string;
  tested_at: string;
  notes: string | null;
};

function validCommitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

function validReleasePublicBaseUrl(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function listReleaseAcceptance(targetVersion = config.releaseTargetVersion): ReleaseAcceptanceView[] {
  const rows = db.prepare(`SELECT platform,target_version,status,commit_sha,account_name,tested_at,notes
    FROM release_acceptance WHERE target_version=? ORDER BY platform`).all(targetVersion) as AcceptanceRow[];
  const byPlatform = new Map(rows.map((row) => [row.platform, row]));
  return RELEASE_PLATFORMS.map((platform) => {
    const row = byPlatform.get(platform);
    return row ? {
      platform,
      targetVersion: row.target_version,
      status: row.status,
      commitSha: row.commit_sha,
      accountName: row.account_name,
      testedAt: row.tested_at,
      notes: row.notes
    } : {
      platform,
      targetVersion,
      status: 'NOT_TESTED',
      commitSha: null,
      accountName: null,
      testedAt: null,
      notes: null
    };
  });
}

export function setReleaseAcceptance(input: {
  platform: Platform;
  status: ReleaseAcceptanceStatus;
  commitSha?: string | null;
  accountName?: string | null;
  notes?: string | null;
  confirmation?: string | null;
  targetVersion?: string;
}): ReleaseAcceptanceView {
  if (!RELEASE_PLATFORMS.includes(input.platform)) throw new Error('Неизвестная площадка release acceptance');
  const targetVersion = input.targetVersion?.trim() || config.releaseTargetVersion;
  if (targetVersion !== config.releaseTargetVersion) throw new Error(`Текущий release gate предназначен для ${config.releaseTargetVersion}`);

  if (input.status === 'NOT_TESTED') {
    const previous = db.prepare('SELECT status,commit_sha,account_name,tested_at,notes FROM release_acceptance WHERE target_version=? AND platform=?')
      .get(targetVersion, input.platform) as Record<string, unknown> | undefined;
    db.prepare('DELETE FROM release_acceptance WHERE target_version=? AND platform=?').run(targetVersion, input.platform);
    event({
      type: 'release_acceptance_reset',
      message: `Release acceptance сброшен: ${input.platform}`,
      data: { targetVersion, platform: input.platform, previous: previous ?? null }
    });
    return listReleaseAcceptance(targetVersion).find((row) => row.platform === input.platform)!;
  }

  if (input.status !== 'PASS' && input.status !== 'FAIL') throw new Error('Допустимы NOT_TESTED, PASS или FAIL');
  const commitSha = String(input.commitSha || '').trim().toLowerCase();
  const accountName = String(input.accountName || '').trim();
  const notes = String(input.notes || '').trim() || null;
  if (!validCommitSha(commitSha)) throw new Error('Нужен полный 40-символьный commit SHA проверяемого release build');
  if (!accountName) throw new Error('Нужно указать имя тестового аккаунта/канала');
  if (accountName.length > 200) throw new Error('Имя тестового аккаунта слишком длинное');
  if (notes && notes.length > 5000) throw new Error('Заметка acceptance не должна превышать 5000 символов');
  if (input.status === 'PASS' && input.confirmation !== 'LIVE PASS') {
    throw new Error('Для PASS требуется явное подтверждение LIVE PASS после реальной проверки площадки');
  }
  if (input.status === 'FAIL' && !notes) throw new Error('Для FAIL нужна заметка с фактической причиной');

  const testedAt = nowIso();
  const rowId = id('accept');
  db.prepare(`INSERT INTO release_acceptance
      (id,target_version,platform,status,commit_sha,account_name,tested_at,notes,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(target_version,platform) DO UPDATE SET
        status=excluded.status,
        commit_sha=excluded.commit_sha,
        account_name=excluded.account_name,
        tested_at=excluded.tested_at,
        notes=excluded.notes,
        updated_at=excluded.updated_at`)
    .run(rowId, targetVersion, input.platform, input.status, commitSha, accountName, testedAt, notes, testedAt);

  event({
    type: 'release_acceptance_updated',
    level: input.status === 'FAIL' ? 'warning' : 'info',
    message: `Release acceptance ${input.status}: ${input.platform}`,
    data: { targetVersion, platform: input.platform, status: input.status, commitSha, accountName, testedAt, notes }
  });
  return listReleaseAcceptance(targetVersion).find((row) => row.platform === input.platform)!;
}

export async function collectReleaseGate(): Promise<ReleaseGateSnapshot> {
  const acceptance = listReleaseAcceptance();
  const diagnostics = await collectDiagnostics();
  const backups = await listBackupBundles();
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const row of acceptance) {
    if (row.status !== 'PASS') blockers.push(`${row.platform}: live acceptance не имеет статуса PASS`);
  }

  const passRows = acceptance.filter((row) => row.status === 'PASS');
  const passShas = new Set(passRows.map((row) => row.commitSha).filter((value): value is string => Boolean(value)));
  const acceptanceCommitSha = passShas.size === 1 && passRows.length === RELEASE_PLATFORMS.length ? [...passShas][0]! : null;
  if (passRows.length === RELEASE_PLATFORMS.length && passShas.size !== 1) {
    blockers.push('Live acceptance выполнен на разных commit SHA; все площадки должны проверяться на одном release build');
  }

  if (!config.appBuildSha) {
    blockers.push(process.env.NODE_ENV === 'production'
      ? 'IMAGE_BUILD_SHA не зашит в production image: пересоберите контейнер с BUILD_SHA=<git rev-parse HEAD>'
      : 'Build SHA не задан: нельзя доказать, что проверяется нужный release commit');
  } else if (acceptanceCommitSha && acceptanceCommitSha !== config.appBuildSha) {
    blockers.push(`Встроенный build SHA ${config.appBuildSha} не совпадает с acceptance commit ${acceptanceCommitSha}`);
  }

  if (!validReleasePublicBaseUrl(config.publicBaseUrl)) {
    blockers.push('Для release acceptance требуется корректный PUBLIC_BASE_URL с HTTPS и hostname');
  }
  if (diagnostics.errors.length > 0) blockers.push(...diagnostics.errors.map((message) => `Диагностика: ${message}`));
  if (diagnostics.recovery.pendingTargets > 0) blockers.push(`Осталось RECOVERY_NEEDED: ${diagnostics.recovery.pendingTargets}`);
  if (diagnostics.scheduler.lastError) blockers.push(`Scheduler: ${diagnostics.scheduler.lastError}`);
  warnings.push(...diagnostics.warnings.map((message) => `Диагностика: ${message}`));

  const testedTimes = passRows.map((row) => row.testedAt).filter((value): value is string => Boolean(value)).sort();
  const latestAcceptanceAt = testedTimes.length === RELEASE_PLATFORMS.length ? testedTimes[testedTimes.length - 1]! : null;
  const latestBackup = backups[0] ? { name: backups[0].name, createdAt: backups[0].createdAt } : null;
  const backupAfterAcceptance = Boolean(latestAcceptanceAt && latestBackup && latestBackup.createdAt >= latestAcceptanceAt);
  if (!latestBackup) blockers.push('Нет полного .tgz backup bundle release-state');
  else if (latestAcceptanceAt && !backupAfterAcceptance) blockers.push('Последний полный backup создан до завершения live acceptance');

  if (blockers.length === 0) {
    warnings.push('Runtime/live gate пройден. Перед созданием стабильного V1 всё равно требуется зелёный Publikator CI / Acceptance на том же commit SHA.');
  }

  return {
    targetVersion: config.releaseTargetVersion,
    appBuildSha: config.appBuildSha || null,
    acceptanceCommitSha,
    generatedAt: nowIso(),
    releaseReady: blockers.length === 0,
    requiresAutomatedCi: true,
    acceptance,
    latestBackup,
    latestAcceptanceAt,
    backupAfterAcceptance,
    diagnosticsSeverity: diagnostics.severity,
    blockers,
    warnings
  };
}
