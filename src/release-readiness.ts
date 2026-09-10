import { collectDiagnostics, type DiagnosticsSnapshot } from './diagnostics.js';
import type { Platform } from './db.js';

export type ReleaseCheckStatus = 'pass' | 'warning' | 'block' | 'external_required';

export type ReleaseReadinessCheck = {
  id: string;
  title: string;
  status: ReleaseCheckStatus;
  message: string;
  evidence?: Record<string, unknown>;
};

export type ReleaseReadinessSnapshot = {
  generatedAt: string;
  releaseCandidate: string;
  automatedReady: boolean;
  stableV1Ready: false;
  automatedBlockers: string[];
  checks: ReleaseReadinessCheck[];
  liveAcceptance: {
    required: true;
    automated: false;
    checklist: string;
    requiredPlatforms: Platform[];
    message: string;
  };
  diagnostics: DiagnosticsSnapshot;
};

const REQUIRED_LIVE_PLATFORMS: Platform[] = ['telegram', 'vk', 'max', 'instagram'];

function check(
  id: string,
  title: string,
  status: ReleaseCheckStatus,
  message: string,
  evidence?: Record<string, unknown>
): ReleaseReadinessCheck {
  return { id, title, status, message, ...(evidence ? { evidence } : {}) };
}

function storageCheck(diagnostics: DiagnosticsSnapshot): ReleaseReadinessCheck {
  const { totalBytes, availableBytes } = diagnostics.storage;
  if (totalBytes === null || availableBytes === null || totalBytes <= 0) {
    return check('storage_space', 'Свободное место DATA_DIR', 'warning', 'Файловая система не вернула statfs; свободное место не удалось доказать автоматически.');
  }
  const ratio = availableBytes / totalBytes;
  const percent = Math.round(ratio * 1000) / 10;
  if (ratio < 0.05) {
    return check('storage_space', 'Свободное место DATA_DIR', 'block', `Доступно только ${percent}% файловой системы. Для RC требуется минимум 5%.`, { totalBytes, availableBytes, availablePercent: percent });
  }
  if (ratio < 0.15) {
    return check('storage_space', 'Свободное место DATA_DIR', 'warning', `Доступно ${percent}% файловой системы; рекомендуется не менее 15%.`, { totalBytes, availableBytes, availablePercent: percent });
  }
  return check('storage_space', 'Свободное место DATA_DIR', 'pass', `Доступно ${percent}% файловой системы.`, { totalBytes, availableBytes, availablePercent: percent });
}

export async function collectReleaseReadiness(): Promise<ReleaseReadinessSnapshot> {
  const diagnostics = await collectDiagnostics();
  const checks: ReleaseReadinessCheck[] = [];

  checks.push(
    diagnostics.app.version === 'unknown'
      ? check('app_version', 'Версия приложения', 'block', 'Версия package.json недоступна.')
      : check('app_version', 'Версия приложения', 'pass', `Версия ${diagnostics.app.version}.`, { version: diagnostics.app.version, node: diagnostics.app.node })
  );

  checks.push(
    diagnostics.database.quickCheck.toLowerCase() === 'ok'
      ? check('sqlite_integrity', 'Целостность SQLite', 'pass', 'SQLite quick_check = ok.', { schemaVersion: diagnostics.database.schemaVersion })
      : check('sqlite_integrity', 'Целостность SQLite', 'block', `SQLite quick_check: ${diagnostics.database.quickCheck}`, { schemaVersion: diagnostics.database.schemaVersion })
  );

  checks.push(
    diagnostics.database.journalMode.toLowerCase() === 'wal'
      ? check('sqlite_wal', 'SQLite WAL', 'pass', 'journal_mode = wal.')
      : check('sqlite_wal', 'SQLite WAL', 'block', `journal_mode = ${diagnostics.database.journalMode}; production contract ожидает WAL.`)
  );

  if (diagnostics.media.missingFiles > 0 || diagnostics.media.sizeMismatches > 0) {
    checks.push(check(
      'media_consistency',
      'Согласованность media',
      'block',
      `Есть missing=${diagnostics.media.missingFiles}, size mismatch=${diagnostics.media.sizeMismatches}.`,
      {
        databaseFiles: diagnostics.media.databaseFiles,
        diskFiles: diagnostics.media.diskFiles,
        missingFiles: diagnostics.media.missingFiles,
        orphanFiles: diagnostics.media.orphanFiles,
        sizeMismatches: diagnostics.media.sizeMismatches
      }
    ));
  } else if (diagnostics.media.orphanFiles > 0 || diagnostics.media.symlinksIgnored > 0) {
    checks.push(check(
      'media_consistency',
      'Согласованность media',
      'warning',
      `Критических потерь нет, но есть orphan=${diagnostics.media.orphanFiles}, symlink=${diagnostics.media.symlinksIgnored}.`,
      { orphanFiles: diagnostics.media.orphanFiles, symlinksIgnored: diagnostics.media.symlinksIgnored }
    ));
  } else {
    checks.push(check('media_consistency', 'Согласованность media', 'pass', `SQLite и disk согласованы: ${diagnostics.media.databaseFiles} файлов.`));
  }

  checks.push(storageCheck(diagnostics));

  checks.push(
    diagnostics.publicMedia.ready
      ? check(
          'public_media_url',
          'PUBLIC_BASE_URL',
          diagnostics.publicMedia.configured && diagnostics.publicMedia.https ? 'pass' : 'warning',
          diagnostics.publicMedia.requiredByEnabledPlatforms.length > 0
            ? `Публичный HTTPS URL готов для ${diagnostics.publicMedia.requiredByEnabledPlatforms.join(', ')}.`
            : diagnostics.publicMedia.configured
              ? `URL настроен: ${diagnostics.publicMedia.publicBaseUrl}.`
              : 'Активные площадки сейчас не требуют public media URL, но PUBLIC_BASE_URL не задан.',
          { ...diagnostics.publicMedia }
        )
      : check(
          'public_media_url',
          'PUBLIC_BASE_URL',
          'block',
          `Активные ${diagnostics.publicMedia.requiredByEnabledPlatforms.join(', ')} требуют корректный HTTPS PUBLIC_BASE_URL.`,
          { ...diagnostics.publicMedia }
        )
  );

  checks.push(
    diagnostics.recovery.pendingTargets === 0
      ? check('recovery_queue', 'RECOVERY_NEEDED', 'pass', 'Неразобранных неопределённых публикаций нет.')
      : check('recovery_queue', 'RECOVERY_NEEDED', 'block', `Требуют ручного решения: ${diagnostics.recovery.pendingTargets}.`, { pendingTargets: diagnostics.recovery.pendingTargets })
  );

  checks.push(
    diagnostics.backups.bundleCount > 0
      ? check('full_backup', 'Полный backup bundle', 'pass', `Доступно bundle: ${diagnostics.backups.bundleCount}. Последний: ${diagnostics.backups.latestBundle}.`, { ...diagnostics.backups })
      : check('full_backup', 'Полный backup bundle', 'block', 'Перед RC/live acceptance необходимо создать хотя бы один полный .tgz backup bundle.')
  );

  checks.push(
    diagnostics.maintenance.active
      ? check('maintenance', 'Maintenance', 'block', `Система находится в maintenance: ${diagnostics.maintenance.reason || 'active'}.`, { ...diagnostics.maintenance })
      : check('maintenance', 'Maintenance', 'pass', 'Maintenance выключен.', { activePublications: diagnostics.maintenance.activePublications, activeRuntimeActivities: diagnostics.maintenance.activeRuntimeActivities })
  );

  checks.push(
    diagnostics.scheduler.lastError
      ? check('scheduler', 'Scheduler', 'block', `Последняя ошибка scheduler: ${diagnostics.scheduler.lastError}`, { lastStartedAt: diagnostics.scheduler.lastStartedAt, lastCompletedAt: diagnostics.scheduler.lastCompletedAt })
      : check(
          'scheduler',
          'Scheduler',
          diagnostics.scheduler.lastCompletedAt ? 'pass' : 'warning',
          diagnostics.scheduler.lastCompletedAt ? `Последний tick завершён ${diagnostics.scheduler.lastCompletedAt}.` : 'После текущего старта scheduler ещё не завершал tick; дождитесь первого цикла.',
          { lastStartedAt: diagnostics.scheduler.lastStartedAt, lastCompletedAt: diagnostics.scheduler.lastCompletedAt, intervalMs: diagnostics.scheduler.intervalMs }
        )
  );

  checks.push(
    diagnostics.retention.lastError
      ? check('retention', 'Retention', 'warning', `Последняя ошибка retention: ${diagnostics.retention.lastError}`, { ...diagnostics.retention })
      : check(
          'retention',
          'Retention',
          'pass',
          `Политика: события ${diagnostics.retention.eventRetentionDays === 0 ? 'без автоочистки' : `${diagnostics.retention.eventRetentionDays} дней`}, backup ${diagnostics.retention.backupRetentionCount === 0 ? 'без автоочистки' : `${diagnostics.retention.backupRetentionCount} последних`}.`,
          { ...diagnostics.retention }
        )
  );

  checks.push(check(
    'live_platform_acceptance',
    'Live acceptance внешних API',
    'external_required',
    'Mock/CI не могут доказать реальную публикацию. Перед stable V1 вручную пройти checklist на Telegram, VK, MAX и Instagram.',
    { requiredPlatforms: REQUIRED_LIVE_PLATFORMS, checklist: 'docs/LIVE_INTEGRATION_CHECKLIST.md' }
  ));

  const automatedBlockers = checks
    .filter((item) => item.status === 'block')
    .map((item) => `${item.title}: ${item.message}`);

  return {
    generatedAt: new Date().toISOString(),
    releaseCandidate: diagnostics.app.version,
    automatedReady: automatedBlockers.length === 0,
    stableV1Ready: false,
    automatedBlockers,
    checks,
    liveAcceptance: {
      required: true,
      automated: false,
      checklist: 'docs/LIVE_INTEGRATION_CHECKLIST.md',
      requiredPlatforms: [...REQUIRED_LIVE_PLATFORMS],
      message: 'Stable V1 намеренно не может стать ready только по automated checks. Требуется ручная проверка реальных внешних площадок и фиксация release commit SHA.'
    },
    diagnostics
  };
}
