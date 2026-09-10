const diagnosticsNav = document.querySelector('#diagnostics-nav');
const opsView = document.querySelector('#view');
const opsPageTitle = document.querySelector('#page-title');

async function opsApi(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.reload();
    throw new Error('Требуется вход');
  }
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function opsEsc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]));
}

function opsBytes(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`;
}

function opsDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function opsSeverityLabel(severity) {
  if (severity === 'ok') return 'Норма';
  if (severity === 'warning') return 'Есть предупреждения';
  return 'Требует внимания';
}

function diagnosticCard(title, state, rows) {
  return `<article class="card ops-diagnostic-card">
    <div class="ops-card-head"><h3>${opsEsc(title)}</h3><span class="ops-dot ${opsEsc(state)}"></span></div>
    <dl>${rows.map(([label, value]) => `<div><dt>${opsEsc(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
  </article>`;
}

function schedulerSeverity(data) {
  if (data.lastError) return 'warning';
  if (data.running) return 'ok';
  return 'ok';
}

function mediaSeverity(data) {
  if (data.missingFiles || data.sizeMismatches) return 'error';
  if (data.orphanFiles || data.symlinksIgnored) return 'warning';
  return 'ok';
}

function publicMediaSeverity(data) {
  if (!data.ready) return 'error';
  if (!data.configured || !data.https) return 'warning';
  return 'ok';
}

async function renderDiagnostics() {
  opsPageTitle.textContent = 'Диагностика';
  opsView.innerHTML = '<div class="muted">Проверка SQLite, scheduler и media storage…</div>';
  try {
    const data = await opsApi('/api/diagnostics');
    const storageUsed = data.storage.totalBytes !== null && data.storage.availableBytes !== null
      ? `${opsBytes(data.storage.availableBytes)} доступно из ${opsBytes(data.storage.totalBytes)}`
      : 'Недоступно';
    const accountText = (data.accounts.byPlatform || [])
      .map((item) => `${item.platform}: ${item.enabled}/${item.total}`)
      .join(' · ') || 'Нет аккаунтов';
    const publicNeeds = data.publicMedia.requiredByEnabledPlatforms?.length
      ? `Нужен для: ${data.publicMedia.requiredByEnabledPlatforms.join(', ')}`
      : 'Сейчас не требуется активными площадками';

    const cards = [
      diagnosticCard('Приложение', 'ok', [
        ['Версия', `<code>${opsEsc(data.app.version)}</code>`],
        ['Node.js', `<code>${opsEsc(data.app.node)}</code>`],
        ['Uptime', `${Math.floor(Number(data.app.uptimeSeconds || 0) / 60)} мин`],
        ['Maintenance', data.maintenance.active ? `<span class="ops-value warning">${opsEsc(data.maintenance.reason || 'active')}</span>` : '<span class="ops-value ok">выключен</span>']
      ]),
      diagnosticCard('SQLite', String(data.database.quickCheck).toLowerCase() === 'ok' ? 'ok' : 'error', [
        ['quick_check', `<code>${opsEsc(data.database.quickCheck)}</code>`],
        ['Schema', String(data.database.schemaVersion)],
        ['Journal', `<code>${opsEsc(data.database.journalMode)}</code>`],
        ['DB', opsBytes(data.database.sizeBytes)],
        ['WAL', opsBytes(data.database.walSizeBytes)],
        ['Посты / события', `${Number(data.database.counts.posts || 0)} / ${Number(data.database.counts.publicationEvents || 0)}`]
      ]),
      diagnosticCard('Scheduler', schedulerSeverity(data.scheduler), [
        ['Состояние', data.scheduler.running ? '<span class="ops-value ok">выполняется</span>' : 'ожидание'],
        ['Интервал', `${Number(data.scheduler.intervalMs || 0)} мс`],
        ['Последний старт', opsEsc(opsDate(data.scheduler.lastStartedAt))],
        ['Завершение', opsEsc(opsDate(data.scheduler.lastCompletedAt))],
        ['Длительность', data.scheduler.lastDurationMs === null ? '—' : `${Number(data.scheduler.lastDurationMs)} мс`],
        ['Работа', `AT ${Number(data.scheduler.lastWork?.duePosts || 0)} · Queue ${Number(data.scheduler.lastWork?.queuePosts || 0)} · Retry ${Number(data.scheduler.lastWork?.retries || 0)}`]
      ]),
      diagnosticCard('Media storage', mediaSeverity(data.media), [
        ['SQLite / диск', `${Number(data.media.databaseFiles)} / ${Number(data.media.diskFiles)} файлов`],
        ['Размер SQLite / диск', `${opsBytes(data.media.databaseBytes)} / ${opsBytes(data.media.diskBytes)}`],
        ['Отсутствуют', `<strong>${Number(data.media.missingFiles)}</strong>`],
        ['Лишние', `<strong>${Number(data.media.orphanFiles)}</strong>`],
        ['Размер не совпадает', `<strong>${Number(data.media.sizeMismatches)}</strong>`],
        ['Symlink игнорировано', String(Number(data.media.symlinksIgnored))]
      ]),
      diagnosticCard('PUBLIC_BASE_URL', publicMediaSeverity(data.publicMedia), [
        ['Адрес', data.publicMedia.publicBaseUrl ? `<code>${opsEsc(data.publicMedia.publicBaseUrl)}</code>` : 'не задан'],
        ['URL', data.publicMedia.validUrl ? 'корректный' : 'не настроен/некорректный'],
        ['HTTPS', data.publicMedia.https ? '<span class="ops-value ok">да</span>' : '<span class="ops-value warning">нет</span>'],
        ['Зависимости', opsEsc(publicNeeds)],
        ['Готовность', data.publicMedia.ready ? '<span class="ops-value ok">готово</span>' : '<span class="ops-value error">блокирует MAX/Instagram</span>']
      ]),
      diagnosticCard('Хранилище и backup', data.backups.bundleCount > 0 ? 'ok' : 'warning', [
        ['Свободное место', opsEsc(storageUsed)],
        ['Backup bundles', String(Number(data.backups.bundleCount))],
        ['Последний bundle', opsEsc(data.backups.latestBundle || '—')],
        ['Legacy SQLite', String(Number(data.backups.legacySqliteCount))],
        ['RECOVERY_NEEDED', `<strong>${Number(data.recovery.pendingTargets)}</strong>`]
      ]),
      diagnosticCard('Соцсети', data.recovery.pendingTargets > 0 ? 'warning' : 'ok', [
        ['Всего аккаунтов', String(Number(data.accounts.total))],
        ['Активных', String(Number(data.accounts.enabled))],
        ['По площадкам', opsEsc(accountText)],
        ['Активных публикаций', String(Number(data.maintenance.activePublications || 0))]
      ])
    ].join('');

    const messages = [
      ...(data.errors || []).map((message) => `<li class="ops-value error">${opsEsc(message)}</li>`),
      ...(data.warnings || []).map((message) => `<li class="ops-value warning">${opsEsc(message)}</li>`)
    ].join('');

    opsView.innerHTML = `
      <div class="ops-diagnostic-toolbar">
        <div>
          <div class="ops-overall ${opsEsc(data.severity)}">${opsEsc(opsSeverityLabel(data.severity))}</div>
          <div class="small muted">Снимок: ${opsEsc(opsDate(data.generatedAt))}. Диагностика ничего не публикует и не возвращает секреты.</div>
        </div>
        <button id="ops-refresh" class="secondary" type="button">Обновить</button>
      </div>
      <div class="ops-diagnostic-grid">${cards}</div>
      <div class="card ops-diagnostic-messages">
        <h3>Что требует внимания</h3>
        ${messages ? `<ul>${messages}</ul>` : '<div class="ops-value ok">Активных предупреждений нет.</div>'}
      </div>`;
    document.querySelector('#ops-refresh')?.addEventListener('click', renderDiagnostics);
  } catch (error) {
    opsView.innerHTML = `<div class="card error">${opsEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

diagnosticsNav?.addEventListener('click', async () => {
  document.querySelectorAll('.nav').forEach((item) => item.classList.remove('active'));
  diagnosticsNav.classList.add('active');
  await renderDiagnostics();
});

function reopenPost(postId) {
  document.querySelectorAll('.modal').forEach((modal) => modal.remove());
  const button = document.querySelector(`.open-post[data-id="${CSS.escape(postId)}"]`);
  if (button instanceof HTMLElement) button.click();
  else window.location.reload();
}

function recoveryDecisionModal(targetId, label) {
  const modal = document.createElement('div');
  modal.className = 'modal ops-recovery-modal';
  modal.innerHTML = `<div class="modal-card">
    <h2>Ручная проверка публикации</h2>
    <div class="ops-recovery-warning">
      <strong>${opsEsc(label)}</strong>
      <p>Publikator не знает, приняла ли внешняя площадка предыдущий POST. Автоматический повтор заблокирован, чтобы не создать дубль.</p>
      <p><strong>Сначала откройте площадку и найдите публикацию вручную.</strong></p>
    </div>
    <label>External ID, если публикация найдена<input id="ops-recovery-external-id" type="text" autocomplete="off" placeholder="необязательно"></label>
    <label>Ссылка на публикацию, если известна<input id="ops-recovery-external-url" type="url" autocomplete="off" placeholder="https://..."></label>
    <div class="ops-recovery-actions">
      <button id="ops-recovery-published" class="primary" type="button">Публикация найдена</button>
      <button id="ops-recovery-absent" class="secondary danger" type="button">Публикации точно нет</button>
      <button id="ops-recovery-cancel" class="secondary" type="button">Отмена</button>
    </div>
    <div id="ops-recovery-error" class="error"></div>
  </div>`;
  document.body.append(modal);
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.remove(); });
  modal.querySelector('#ops-recovery-cancel').addEventListener('click', () => modal.remove());

  const errorBox = modal.querySelector('#ops-recovery-error');
  const setBusy = (busy) => modal.querySelectorAll('button').forEach((button) => { button.disabled = busy; });

  modal.querySelector('#ops-recovery-published').addEventListener('click', async () => {
    if (!window.confirm('Подтвердить, что публикация реально существует на внешней площадке? После этого target будет считаться PUBLISHED.')) return;
    try {
      setBusy(true);
      errorBox.textContent = '';
      const externalId = modal.querySelector('#ops-recovery-external-id').value.trim() || null;
      const externalUrl = modal.querySelector('#ops-recovery-external-url').value.trim() || null;
      const result = await opsApi(`/api/targets/${encodeURIComponent(targetId)}/recovery/confirm-published`, {
        method: 'POST',
        body: JSON.stringify({ externalId, externalUrl })
      });
      reopenPost(result.postId);
    } catch (error) {
      setBusy(false);
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  modal.querySelector('#ops-recovery-absent').addEventListener('click', async () => {
    if (!window.confirm('Подтвердить, что вы вручную проверили площадку и публикации там точно нет? После этого обычный ручной повтор станет доступен, но не запустится автоматически.')) return;
    try {
      setBusy(true);
      errorBox.textContent = '';
      const result = await opsApi(`/api/targets/${encodeURIComponent(targetId)}/recovery/confirm-not-published`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      reopenPost(result.postId);
    } catch (error) {
      setBusy(false);
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    }
  });
}

function enhanceRecoveryRows(root = document) {
  root.querySelectorAll('.retry-target:not(.ops-recovery-enhanced)').forEach((button) => {
    const row = button.closest('tr');
    const badges = row ? [...row.querySelectorAll('.badge')] : [];
    const recoveryBadge = badges.find((badge) => badge.textContent?.trim() === 'RECOVERY_NEEDED');
    if (!recoveryBadge) return;

    const replacement = button.cloneNode(true);
    replacement.classList.remove('retry-target');
    replacement.classList.add('ops-recovery-enhanced', 'ops-recovery-target');
    replacement.textContent = 'Разобрать';
    button.replaceWith(replacement);
    replacement.addEventListener('click', () => {
      const label = row?.querySelector('td')?.textContent?.trim() || 'Площадка';
      recoveryDecisionModal(replacement.dataset.id, label);
    });
  });
}

const recoveryObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;
      enhanceRecoveryRows(node);
      if (node.matches?.('.retry-target')) enhanceRecoveryRows(node.parentElement || document);
    }
  }
});
recoveryObserver.observe(document.body, { childList: true, subtree: true });
enhanceRecoveryRows();
