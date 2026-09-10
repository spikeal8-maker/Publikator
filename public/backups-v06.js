function backupEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[char]);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} Б`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} КБ`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  return `${(value / 1024 ** 3).toFixed(2)} ГБ`;
}

async function backupRequest(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.text().catch(() => '');
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && payload.error ? payload.error : `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return payload;
}

function setBackupStatus(message, kind = '') {
  const element = document.querySelector('#backup-v06-status');
  if (!element) return;
  element.textContent = message;
  element.className = `backup-status ${kind}`.trim();
}

async function renderBackupV06() {
  const view = document.querySelector('#view');
  if (!view) return;
  let rows;
  try {
    rows = await backupRequest('/api/backup-bundles');
  } catch (error) {
    view.innerHTML = `<div id="backup-v06" class="card"><div class="error">${backupEscape(error instanceof Error ? error.message : String(error))}</div></div>`;
    return;
  }

  view.innerHTML = `<section id="backup-v06" class="backup-v06">
    <div class="backup-hero card">
      <div>
        <h2>Полные резервные копии</h2>
        <p>Один архив содержит SQLite, все изображения и проверочный manifest. APP_MASTER_KEY в архив не записывается.</p>
      </div>
      <button id="make-backup" class="primary" type="button">Создать полный backup</button>
    </div>

    <div class="backup-safety card">
      <strong>Безопасное восстановление</strong>
      <div class="small muted">Перед restore Publikator проверяет формат, версию схемы, APP_MASTER_KEY fingerprint, SQLite integrity_check, размеры и SHA-256 всех media. Затем автоматически создаётся pre-restore backup, приложение перезапускается и только при старте заменяет данные.</div>
    </div>

    <div id="backup-v06-status" class="backup-status"></div>

    <div class="backup-layout">
      <div class="card">
        <div class="backup-section-head"><h3>Сохранённые копии</h3><span class="badge">${rows.length}</span></div>
        <div class="backup-list">
          ${rows.map((row) => `<div class="backup-row">
            <div class="backup-row-main">
              <strong>${backupEscape(row.name)}</strong>
              <div class="small muted">${backupEscape(new Date(row.createdAt).toLocaleString())} · ${formatBytes(row.sizeBytes)}</div>
            </div>
            <div class="row-actions">
              <a class="secondary backup-download" href="/api/backup-bundles/${encodeURIComponent(row.name)}/download">Скачать</a>
              <button type="button" class="secondary danger restore-stored" data-name="${backupEscape(row.name)}">Восстановить</button>
            </div>
          </div>`).join('') || '<div class="muted">Полных backup bundle пока нет.</div>'}
        </div>
      </div>

      <div class="card backup-upload-card">
        <h3>Восстановить из файла</h3>
        <p class="small muted">Принимается архив <code>.tgz</code> / <code>.tar.gz</code> до 2 ГБ. Архив сначала полностью валидируется и только затем ставится в очередь восстановления.</p>
        <input id="restore-upload-file" type="file" accept=".tgz,.gz,application/gzip">
        <button id="restore-upload" class="secondary danger" type="button">Проверить и восстановить</button>
        <div class="small muted">Для любого восстановления потребуется вручную ввести <strong>RESTORE</strong>.</div>
      </div>
    </div>

    <div class="small muted backup-legacy-note">Старые одиночные <code>.sqlite</code>-файлы могут оставаться в каталоге backups после прежних версий, но API их создания отключён. Рабочий формат резервной копии — только полный <code>.tgz</code> bundle с SQLite, media и manifest.</div>
  </section>`;

  document.querySelector('#make-backup')?.addEventListener('click', async () => {
    try {
      setBackupStatus('Создаётся согласованный snapshot базы и изображений…');
      const result = await backupRequest('/api/backup-bundles', { method: 'POST', body: JSON.stringify({ label: 'manual' }) });
      setBackupStatus(`Создан ${result.name}`, 'success-text');
      await renderBackupV06();
    } catch (error) {
      setBackupStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  document.querySelectorAll('.restore-stored').forEach((button) => button.addEventListener('click', async () => {
    const name = button.dataset.name;
    if (!name) return;
    const confirmation = window.prompt(`Будут восстановлены данные из ${name}. Текущее состояние сначала сохранится в pre-restore backup.\n\nВведите RESTORE:`);
    if (confirmation !== 'RESTORE') {
      setBackupStatus('Восстановление отменено: подтверждение не введено.');
      return;
    }
    try {
      button.disabled = true;
      setBackupStatus('Проверка архива и создание pre-restore backup…');
      const result = await backupRequest(`/api/backup-bundles/${encodeURIComponent(name)}/restore`, {
        method: 'POST',
        headers: { 'x-publikator-restore': 'RESTORE' }
      });
      await showRestartState(result);
    } catch (error) {
      button.disabled = false;
      setBackupStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }));

  document.querySelector('#restore-upload')?.addEventListener('click', async () => {
    const input = document.querySelector('#restore-upload-file');
    const file = input?.files?.[0];
    if (!file) {
      setBackupStatus('Сначала выберите backup bundle.', 'error');
      return;
    }
    const confirmation = window.prompt(`Будет проверен и восстановлен файл ${file.name}. Текущее состояние сначала сохранится.\n\nВведите RESTORE:`);
    if (confirmation !== 'RESTORE') {
      setBackupStatus('Восстановление отменено: подтверждение не введено.');
      return;
    }
    const formData = new FormData();
    formData.append('file', file, file.name);
    const button = document.querySelector('#restore-upload');
    try {
      button.disabled = true;
      setBackupStatus('Загрузка и полная проверка backup bundle…');
      const result = await backupRequest('/api/backup-bundles/restore-upload', {
        method: 'POST',
        headers: { 'x-publikator-restore': 'RESTORE' },
        body: formData
      });
      await showRestartState(result);
    } catch (error) {
      button.disabled = false;
      setBackupStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  });
}

async function showRestartState(result) {
  const preRestore = result?.preRestoreBackup?.name ? ` Предварительная копия: ${result.preRestoreBackup.name}.` : '';
  setBackupStatus(`Backup проверен. Publikator перезапускается и применяет восстановление.${preRestore}`, 'success-text');
  document.querySelectorAll('#backup-v06 button, #backup-v06 input').forEach((element) => { element.disabled = true; });
  await new Promise((resolve) => setTimeout(resolve, 1400));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (response.ok) {
        window.location.reload();
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  setBackupStatus('Контейнер пока не вернулся после восстановления. Проверьте Docker logs; исходные данные защищены pre-restore backup.', 'error');
}

window.PublikatorRenderFullBackups = renderBackupV06;

function tryEnhanceBackupPage() {
  const legacyButton = document.querySelector('#make-backup');
  if (!legacyButton || document.querySelector('#backup-v06')) return;
  renderBackupV06().catch(() => undefined);
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest('#make-backup') || document.querySelector('#backup-v06')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  renderBackupV06().catch(() => undefined);
}, true);

const backupObserver = new MutationObserver(() => tryEnhanceBackupPage());
backupObserver.observe(document.body, { childList: true, subtree: true });
tryEnhanceBackupPage();
