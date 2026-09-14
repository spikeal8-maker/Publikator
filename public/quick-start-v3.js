const quickView = document.querySelector('#view');
const quickTitle = document.querySelector('#page-title');
const quickApp = document.querySelector('#app');
let quickRendering = false;
let quickScheduled = false;
let quickFile = null;
let quickPreview = null;

async function quickApi(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {})
    }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

function quickEsc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function quickOpen(selector) {
  document.querySelector(selector)?.click();
}

function quickAccountSummary(accounts) {
  if (!accounts.length) return '<div class="quick-empty">Подключений пока нет.</div>';
  return accounts.slice(0, 6).map((account) => `
    <div class="quick-account">
      <span class="quick-platform">${quickEsc(account.platform)}</span>
      <strong>${quickEsc(account.name)}</strong>
      <span>${account.enabled ? 'Включено' : 'Отключено'}</span>
    </div>`).join('');
}

function quickIssueSummary(validation) {
  const invalid = (validation.rows || []).filter((row) => !row.valid).slice(0, 5);
  if (!invalid.length) return '';
  return `<div class="quick-errors"><strong>Что исправить</strong>${invalid.map((row) => {
    const text = (row.issues || []).map((issue) => `${issue.column}: ${issue.message}`).join('; ');
    return `<div>Строка ${Number(row.rowNumber || 0)} — ${quickEsc(text)}</div>`;
  }).join('')}</div>`;
}

function quickDownloadTemplate(columns) {
  const content = `\uFEFF${columns.join(';')}\r\n`;
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'publikator-content-plan-template.csv';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function quickPreviewFile() {
  const result = document.querySelector('#quick-import-result');
  const apply = document.querySelector('#quick-apply');
  if (!quickFile || !result || !apply) return;
  apply.disabled = true;
  quickPreview = null;
  result.innerHTML = '<div class="quick-progress">Проверяю таблицу. Ничего пока не импортируется…</div>';
  try {
    const data = new FormData();
    data.set('file', quickFile);
    const validation = await quickApi('/api/content-plan/import/preview', { method: 'POST', body: data });
    quickPreview = validation;
    const summary = validation.summary || {};
    result.innerHTML = `<div class="quick-preview ${validation.canApply ? 'is-ready' : 'is-blocked'}">
      <strong>${validation.canApply ? 'Таблица готова к импорту' : 'В таблице есть ошибки'}</strong>
      <span>Строк: ${Number(summary.totalRows || 0)} · готово: ${Number(summary.validRows || 0)} · ошибок: ${Number(summary.invalidRows || 0)}</span>
      ${quickIssueSummary(validation)}
    </div>`;
    apply.disabled = !validation.canApply;
  } catch (error) {
    result.innerHTML = `<div class="quick-errors">${quickEsc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

async function quickApplyFile() {
  const result = document.querySelector('#quick-import-result');
  const apply = document.querySelector('#quick-apply');
  if (!quickFile || !quickPreview?.canApply || !quickPreview.fileSha256 || !result || !apply) return;
  if (!window.confirm(`Импортировать ${quickPreview.summary.validRows} строк как черновики? Публикация наружу автоматически не начнётся.`)) return;
  apply.disabled = true;
  result.innerHTML = '<div class="quick-progress">Импортирую черновики…</div>';
  try {
    const data = new FormData();
    data.set('file', quickFile);
    const imported = await quickApi('/api/content-plan/import/apply', {
      method: 'POST',
      body: data,
      headers: {
        'x-publikator-content-plan': 'IMPORT',
        'x-content-plan-sha256': quickPreview.fileSha256
      }
    });
    result.innerHTML = `<div class="quick-preview is-ready"><strong>Готово: создано ${Number(imported.createdCount || 0)} черновиков</strong><span>Теперь откройте «Контент», проверьте материалы и выберите площадки.</span><button id="quick-open-content-after" class="primary" type="button">Открыть контент</button></div>`;
    document.querySelector('#quick-open-content-after')?.addEventListener('click', () => quickOpen('.nav[data-view="posts"]'));
    quickPreview = null;
    quickFile = null;
  } catch (error) {
    result.innerHTML = `<div class="quick-errors">${quickEsc(error instanceof Error ? error.message : String(error))}</div>`;
    apply.disabled = false;
  }
}

async function renderQuickStart() {
  if (quickRendering || !quickView || !quickTitle || !quickApp) return;
  if (quickApp.classList.contains('hidden') || quickTitle.textContent?.trim() !== 'Старт') return;
  quickRendering = true;
  try {
    const [accounts, projects, posts, schema] = await Promise.all([
      quickApi('/api/accounts'),
      quickApi('/api/projects'),
      quickApi('/api/posts'),
      quickApi('/api/content-plan/schema')
    ]);
    const enabledAccounts = accounts.filter((account) => account.enabled);
    const drafts = posts.filter((post) => post.status === 'DRAFT').length;
    const ready = posts.filter((post) => post.status === 'READY').length;

    quickView.innerHTML = `<div class="quick-root">
      <section class="quick-hero">
        <div><span class="quick-kicker">Рабочий старт</span><h2>Подключите площадки, загрузите таблицу и публикуйте</h2><p>Вам не нужно создавать публикации по одной. Publikator принимает CSV/XLSX, превращает строки в черновики и дальше ведёт их через проверку и расписание.</p></div>
        <div class="quick-hero-stats"><strong>${enabledAccounts.length}</strong><span>активных соцсетей</span><strong>${drafts}</strong><span>черновиков</span></div>
      </section>

      <div class="quick-steps">
        <section class="quick-step">
          <div class="quick-step-number">1</div>
          <div class="quick-step-body"><h3>Подключите соцсети</h3><p>Добавьте токен и конкретный канал, группу или чат. Кнопка «Проверить» покажет, куда именно будет публиковаться контент.</p>
            <div class="quick-account-list">${quickAccountSummary(accounts)}</div>
            <button id="quick-open-accounts" class="primary" type="button">${accounts.length ? 'Управлять соцсетями' : 'Подключить Telegram / VK / MAX'}</button>
          </div>
        </section>

        <section class="quick-step quick-import-step">
          <div class="quick-step-number">2</div>
          <div class="quick-step-body"><h3>Загрузите контент-план</h3><p>CSV или XLSX. Сначала выполняется безопасная проверка, и только после неё появляется кнопка импорта.</p>
            <div class="quick-template-row"><button id="quick-template" class="secondary" type="button">Скачать пустой шаблон CSV</button><span>${Number(schema.columns?.length || 0)} колонок · Excel открывает CSV</span></div>
            <label class="quick-drop"><input id="quick-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"><strong>Выбрать CSV/XLSX</strong><span id="quick-file-name">или перетащите таблицу сюда</span></label>
            <div class="row-actions"><button id="quick-preview" class="primary" type="button" disabled>Проверить таблицу</button><button id="quick-apply" class="secondary" type="button" disabled>Импортировать черновики</button><button id="quick-open-import" class="secondary" type="button">Открыть полный импорт</button></div>
            <div id="quick-import-result"></div>
          </div>
        </section>

        <section class="quick-step">
          <div class="quick-step-number">3</div>
          <div class="quick-step-body"><h3>Проверьте и запустите</h3><p>Импорт ничего не публикует автоматически. Проверьте текст и медиа, выберите площадки, затем используйте календарь или расписание.</p>
            <div class="quick-status-row"><span>Черновики <strong>${drafts}</strong></span><span>Готовы <strong>${ready}</strong></span><span>Проекты <strong>${projects.length}</strong></span></div>
            <div class="row-actions"><button id="quick-open-content" class="primary" type="button">Открыть контент</button><button id="quick-open-calendar" class="secondary" type="button">Открыть календарь</button><button id="quick-open-schedule" class="secondary" type="button">Расписание</button></div>
          </div>
        </section>
      </div>

      <section class="quick-note"><strong>Системные проверки не мешают работе.</strong><span>Диагностика, резервные копии и проверка выпуска находятся внизу меню. Для обычной работы они не нужны.</span></section>
    </div>`;

    document.querySelector('#quick-open-accounts')?.addEventListener('click', () => quickOpen('.nav[data-view="accounts"]'));
    document.querySelector('#quick-open-content')?.addEventListener('click', () => quickOpen('.nav[data-view="posts"]'));
    document.querySelector('#quick-open-calendar')?.addEventListener('click', () => quickOpen('#calendar-nav'));
    document.querySelector('#quick-open-schedule')?.addEventListener('click', () => quickOpen('.nav[data-view="schedules"]'));
    document.querySelector('#quick-open-import')?.addEventListener('click', () => quickOpen('#content-plan-nav'));
    document.querySelector('#quick-template')?.addEventListener('click', () => quickDownloadTemplate(schema.columns || []));
    const input = document.querySelector('#quick-file');
    input?.addEventListener('change', () => {
      quickFile = input.files?.[0] || null;
      quickPreview = null;
      const name = document.querySelector('#quick-file-name');
      if (name) name.textContent = quickFile ? `${quickFile.name} · ${(quickFile.size / 1024).toFixed(1)} КБ` : 'или перетащите таблицу сюда';
      const preview = document.querySelector('#quick-preview');
      const apply = document.querySelector('#quick-apply');
      if (preview) preview.disabled = !quickFile;
      if (apply) apply.disabled = true;
      const result = document.querySelector('#quick-import-result');
      if (result) result.innerHTML = '';
    });
    document.querySelector('#quick-preview')?.addEventListener('click', quickPreviewFile);
    document.querySelector('#quick-apply')?.addEventListener('click', quickApplyFile);
  } catch (error) {
    quickView.innerHTML = `<div class="card error">${quickEsc(error instanceof Error ? error.message : String(error))}</div>`;
  } finally {
    quickRendering = false;
  }
}

function scheduleQuickStart() {
  if (quickScheduled) return;
  quickScheduled = true;
  setTimeout(() => {
    quickScheduled = false;
    if (quickTitle?.textContent?.trim() === 'Старт' && !quickView?.querySelector('.quick-root')) renderQuickStart();
  }, 0);
}

const quickObserver = new MutationObserver(() => scheduleQuickStart());
if (quickView) quickObserver.observe(quickView, { childList: true });
if (quickTitle) quickObserver.observe(quickTitle, { childList: true, subtree: true, characterData: true });
if (quickApp) quickObserver.observe(quickApp, { attributes: true, attributeFilter: ['class'] });
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.nav[data-view="dashboard"]')) scheduleQuickStart();
}, true);
setTimeout(() => renderQuickStart(), 0);
