const contentPlanNav = document.querySelector('#content-plan-nav');
const view = document.querySelector('#view');
const pageTitle = document.querySelector('#page-title');

let contentPlanFile = null;
let contentPlanPreview = null;

async function cpApi(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();
  if (response.status === 401) {
    window.location.reload();
    throw new Error('Требуется вход');
  }
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

function cpEsc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]));
}

function cpPrettyBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}

function cpExportUrl(format, projectId) {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return `/api/content-plan/export.${format}${suffix}`;
}

function cpRenderIssues(issues = []) {
  if (!issues.length) return '<span class="cp-ok">Ошибок нет</span>';
  return `<ul class="cp-issues">${issues.map((issue) => `<li class="${issue.level === 'error' ? 'cp-error' : 'cp-warning'}"><strong>${cpEsc(issue.column)}</strong>: ${cpEsc(issue.message)}</li>`).join('')}</ul>`;
}

function cpRenderPreview(validation) {
  const preview = document.querySelector('#cp-preview');
  if (!preview) return;

  const summary = validation.summary || {};
  const rows = validation.rows || [];
  preview.innerHTML = `
    <div class="cp-summary-grid">
      <div class="card metric">Строк<strong>${Number(summary.totalRows || 0)}</strong></div>
      <div class="card metric">Корректных<strong>${Number(summary.validRows || 0)}</strong></div>
      <div class="card metric">С ошибками<strong>${Number(summary.invalidRows || 0)}</strong></div>
      <div class="card metric">Предупреждений<strong>${Number(summary.warnings || 0)}</strong></div>
    </div>
    <div class="cp-validation-state ${validation.canApply ? 'cp-ready' : 'cp-blocked'}">
      ${validation.canApply
        ? 'Dry-run пройден. Этот же файл можно импортировать после подтверждения.'
        : 'Импорт заблокирован: исправьте ошибки в файле и выполните dry-run повторно.'}
    </div>
    <div class="cp-hash">SHA-256 preview: <code>${cpEsc(validation.fileSha256 || '')}</code></div>
    <div class="cp-table-wrap">
      <table class="table cp-table">
        <thead><tr><th>Строка</th><th>Статус</th><th>Публикация</th><th>Цели</th><th>Медиа</th><th>Проверка</th></tr></thead>
        <tbody>
          ${rows.map((row) => {
            const normalized = row.normalized;
            const targetCount = normalized?.targets?.length || 0;
            const mediaCount = normalized?.media?.length || 0;
            const schedule = normalized ? `${normalized.scheduleMode}${normalized.scheduledAt ? ` · ${new Date(normalized.scheduledAt).toLocaleString()}` : ''}` : '—';
            return `<tr>
              <td>${Number(row.rowNumber || 0)}</td>
              <td>${row.valid ? '<span class="badge PUBLISHED">OK</span>' : '<span class="badge FAILED">Ошибка</span>'}</td>
              <td>${normalized ? `<strong>${cpEsc(normalized.title)}</strong><div class="small muted">${cpEsc(normalized.project)} · ${cpEsc(schedule)}</div>` : '—'}</td>
              <td>${targetCount}</td>
              <td>${mediaCount}</td>
              <td>${cpRenderIssues(row.issues)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  const applyButton = document.querySelector('#cp-apply');
  if (applyButton) applyButton.disabled = !validation.canApply;
}

async function cpPreviewSelectedFile() {
  const error = document.querySelector('#cp-error');
  const status = document.querySelector('#cp-status');
  const applyButton = document.querySelector('#cp-apply');
  if (error) error.textContent = '';
  if (!contentPlanFile) {
    if (error) error.textContent = 'Выберите CSV или XLSX файл.';
    return;
  }

  if (applyButton) applyButton.disabled = true;
  if (status) status.textContent = 'Проверка файла без записи в БД…';
  contentPlanPreview = null;

  try {
    const data = new FormData();
    data.set('file', contentPlanFile);
    const validation = await cpApi('/api/content-plan/import/preview', { method: 'POST', body: data });
    contentPlanPreview = validation;
    cpRenderPreview(validation);
    if (status) status.textContent = validation.canApply
      ? `Dry-run пройден: ${validation.summary.validRows} строк готово к импорту.`
      : `Dry-run завершён: ${validation.summary.invalidRows} строк с ошибками.`;
  } catch (err) {
    if (status) status.textContent = '';
    if (error) error.textContent = err.message;
  }
}

async function cpApplySelectedFile() {
  const error = document.querySelector('#cp-error');
  const status = document.querySelector('#cp-status');
  const applyButton = document.querySelector('#cp-apply');
  if (error) error.textContent = '';
  if (!contentPlanFile || !contentPlanPreview?.canApply || !contentPlanPreview.fileSha256) {
    if (error) error.textContent = 'Сначала выполните успешный dry-run этого файла.';
    return;
  }

  const confirmed = window.confirm(`Импортировать ${contentPlanPreview.summary.validRows} строк как новые DRAFT-публикации? Файл будет повторно проверен перед записью.`);
  if (!confirmed) return;

  if (applyButton) applyButton.disabled = true;
  if (status) status.textContent = 'Повторная проверка и импорт…';

  try {
    const data = new FormData();
    data.set('file', contentPlanFile);
    const result = await cpApi('/api/content-plan/import/apply', {
      method: 'POST',
      body: data,
      headers: {
        'x-publikator-content-plan': 'IMPORT',
        'x-content-plan-sha256': contentPlanPreview.fileSha256
      }
    });
    if (status) status.textContent = `Импорт завершён: создано ${result.createdCount} DRAFT-публикаций.`;
    const preview = document.querySelector('#cp-preview');
    if (preview) preview.innerHTML = `<div class="card cp-import-success"><strong>Импорт завершён</strong><div>Создано публикаций: ${Number(result.createdCount || 0)}</div><div class="small muted">Откройте раздел «Контент», проверьте публикации и только затем переводите их в READY.</div></div>`;
    contentPlanPreview = null;
  } catch (err) {
    if (status) status.textContent = '';
    if (error) error.textContent = err.message;
    if (contentPlanPreview?.canApply && applyButton) applyButton.disabled = false;
  }
}

async function renderContentPlan() {
  pageTitle.textContent = 'Контент-план';
  view.innerHTML = '<div class="muted">Загрузка…</div>';
  contentPlanFile = null;
  contentPlanPreview = null;

  try {
    const [projects, schema] = await Promise.all([
      cpApi('/api/projects'),
      cpApi('/api/content-plan/schema')
    ]);

    view.innerHTML = `
      <div class="cp-layout">
        <div class="card">
          <h2>Экспорт</h2>
          <p class="muted">Одна строка = одна публикация. Экспорт сохраняет проект, расписание, выбранные аккаунты, отдельные тексты площадок и ссылки на media.</p>
          <label>Проект
            <select id="cp-project">
              <option value="">Все проекты</option>
              ${projects.map((project) => `<option value="${cpEsc(project.id)}">${cpEsc(project.name)} · ${cpEsc(project.slug)}</option>`).join('')}
            </select>
          </label>
          <div class="row-actions cp-export-actions">
            <a id="cp-export-csv" class="button-link primary" href="${cpExportUrl('csv', '')}">Скачать CSV</a>
            <a id="cp-export-xlsx" class="button-link secondary" href="${cpExportUrl('xlsx', '')}">Скачать XLSX</a>
          </div>
        </div>

        <div class="card">
          <h2>Импорт</h2>
          <p class="muted">Сначала выполняется dry-run: файл полностью разбирается и проверяется без записи в БД. Apply разрешается только при нуле ошибок и только для того же SHA-256 файла.</p>
          <input id="cp-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
          <div id="cp-file-info" class="small muted">Файл не выбран.</div>
          <div class="row-actions cp-import-actions">
            <button id="cp-preview-button" class="primary" type="button">Проверить dry-run</button>
            <button id="cp-apply" class="secondary" type="button" disabled>Импортировать</button>
          </div>
          <div id="cp-status" class="cp-status"></div>
          <div id="cp-error" class="error"></div>
        </div>
      </div>

      <div class="card cp-schema-card">
        <h2>Схема v${Number(schema.version || 1)}</h2>
        <div class="cp-columns">${(schema.columns || []).map((column) => `<code>${cpEsc(column)}</code>`).join('')}</div>
        <p class="small muted">project — slug существующего проекта; schedule_mode — MANUAL / AT / QUEUE; targets, platform_overrides и media_references — JSON-массивы внутри ячеек.</p>
        <p class="small muted">Media references не загружают внешние файлы: они указывают на уже существующие изображения Publikator и при импорте копируются в новый DRAFT. Для переноса всей установки между серверами используйте полный backup bundle.</p>
      </div>

      <div id="cp-preview"></div>`;

    const projectSelect = document.querySelector('#cp-project');
    const csvLink = document.querySelector('#cp-export-csv');
    const xlsxLink = document.querySelector('#cp-export-xlsx');
    projectSelect.addEventListener('change', () => {
      csvLink.href = cpExportUrl('csv', projectSelect.value);
      xlsxLink.href = cpExportUrl('xlsx', projectSelect.value);
    });

    document.querySelector('#cp-file').addEventListener('change', (event) => {
      contentPlanFile = event.target.files?.[0] || null;
      contentPlanPreview = null;
      document.querySelector('#cp-apply').disabled = true;
      document.querySelector('#cp-preview').innerHTML = '';
      document.querySelector('#cp-error').textContent = '';
      document.querySelector('#cp-status').textContent = '';
      document.querySelector('#cp-file-info').textContent = contentPlanFile
        ? `${contentPlanFile.name} · ${cpPrettyBytes(contentPlanFile.size)}`
        : 'Файл не выбран.';
    });

    document.querySelector('#cp-preview-button').addEventListener('click', cpPreviewSelectedFile);
    document.querySelector('#cp-apply').addEventListener('click', cpApplySelectedFile);
  } catch (err) {
    view.innerHTML = `<div class="card error">${cpEsc(err.message)}</div>`;
  }
}

contentPlanNav?.addEventListener('click', async () => {
  document.querySelectorAll('.nav').forEach((item) => item.classList.remove('active'));
  contentPlanNav.classList.add('active');
  await renderContentPlan();
});
